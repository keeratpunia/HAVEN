import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import sharp from 'sharp';
import supertest from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { FakeClock } from '../src/lib/clock.js';
import { LocalDiskMediaStorage } from '../src/gate/media.js';
import { SupabaseMediaStorage } from '../src/media/supabase-storage.js';
import { createMediaStorage } from '../src/media/storage.js';
import { resetAllHavenTables } from './db-test-helper.js';
import { API_BASE_URL, buildTestApp, db, issueToken, JWT_SECRET } from './app-test-helpers.js';
import { MediaUrlSigner } from '../src/media/signing.js';
import { makeVisitor } from './visits-fixtures.js';

/**
 * FINAL-QA-REPORT D-03, SDD §9.10: photos live in three private Supabase Storage
 * buckets at the §9.10 paths, are read only through 120 s signed URLs, and can be
 * deleted. This is a contract test against a fake Storage HTTP server that behaves
 * like Supabase's REST API (private buckets, service-role auth, signed tokens with an
 * expiry). Verifying against a real bucket is part of the deployment milestone.
 */

const KEY = 'service-role-key-for-contract-test';
const BUCKETS = new Set(['visitor-photos', 'gate-photos', 'resident-docs']);

interface FakeStorage {
  url: string;
  objects: Map<string, { bytes: Buffer; contentType: string }>;
  signed: Map<string, { key: string; expiresAt: number }>;
  requests: { method: string; path: string; authorized: boolean }[];
  close: () => Promise<void>;
}

async function startFakeStorage(): Promise<FakeStorage> {
  const objects = new Map<string, { bytes: Buffer; contentType: string }>();
  const signed = new Map<string, { key: string; expiresAt: number }>();
  const requests: FakeStorage['requests'] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const u = new URL(req.url ?? '/', 'http://fake');
      const authorized =
        req.headers.authorization === `Bearer ${KEY}` && req.headers.apikey === KEY;
      requests.push({ method: req.method ?? '', path: u.pathname, authorized });
      const json = (status: number, value: unknown) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(value));
      };
      const notFound = () =>
        json(400, { statusCode: '404', error: 'not_found', message: 'Object not found' });
      const m = /^\/storage\/v1\/object\/(?:(authenticated|sign)\/)?([^/]+)(?:\/(.+))?$/.exec(
        u.pathname,
      );
      if (!m) return json(404, { error: 'route' });
      const [, mode, bucket = '', rawPath] = m;
      if (!BUCKETS.has(bucket)) return json(400, { statusCode: '404', error: 'Bucket not found' });
      const path = rawPath ? decodeURIComponent(rawPath) : '';
      const key = `${bucket}/${path}`;

      // A signed URL is the only way in without the service-role key.
      if (mode === 'sign' && req.method === 'GET') {
        const token = u.searchParams.get('token') ?? '';
        const grant = signed.get(token);
        if (!grant || grant.key !== key || grant.expiresAt < Date.now()) {
          return json(400, { statusCode: '403', error: 'InvalidJWT' });
        }
        const obj = objects.get(key);
        if (!obj) return notFound();
        res.writeHead(200, { 'Content-Type': obj.contentType });
        return res.end(obj.bytes);
      }
      if (!authorized) return json(400, { statusCode: '403', error: 'Unauthorized' });

      if (mode === 'sign' && req.method === 'POST') {
        if (!objects.has(key)) return notFound();
        const { expiresIn } = JSON.parse(body.toString()) as { expiresIn: number };
        const token = randomUUID();
        signed.set(token, { key, expiresAt: Date.now() + expiresIn * 1000 });
        return json(200, { signedURL: `/object/sign/${bucket}/${rawPath}?token=${token}` });
      }
      if (mode === 'authenticated' && req.method === 'GET') {
        const obj = objects.get(key);
        if (!obj) return notFound();
        res.writeHead(200, { 'Content-Type': obj.contentType });
        return res.end(obj.bytes);
      }
      if (!mode && req.method === 'POST' && path) {
        if (objects.has(key) && req.headers['x-upsert'] !== 'true') {
          return json(400, { statusCode: '409', error: 'Duplicate' });
        }
        objects.set(key, { bytes: body, contentType: String(req.headers['content-type']) });
        return json(200, { Key: key });
      }
      if (!mode && req.method === 'DELETE' && !path) {
        const { prefixes } = JSON.parse(body.toString()) as { prefixes: string[] };
        const removed = prefixes.filter((p) => objects.delete(`${bucket}/${p}`));
        return json(
          200,
          removed.map((name) => ({ name })),
        );
      }
      return json(404, { error: 'route' });
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    objects,
    signed,
    requests,
    close: () => new Promise((r) => server.close(() => r())),
  };
}

let fake: FakeStorage;
beforeAll(async () => {
  fake = await startFakeStorage();
});
afterAll(async () => {
  await fake.close();
});
beforeEach(() => {
  fake.objects.clear();
  fake.signed.clear();
  fake.requests.length = 0;
});

const jpeg = (r: number) =>
  sharp({ create: { width: 120, height: 120, channels: 3, background: { r, g: 80, b: 160 } } })
    .jpeg()
    .toBuffer();

describe('SupabaseMediaStorage against the Storage REST contract (§9.10)', () => {
  it('stores, reads back, signs for 120 s and deletes objects in the private buckets', async () => {
    const storage = new SupabaseMediaStorage(fake.url, KEY);
    const visitorId = randomUUID();
    const mediaId = randomUUID();
    const object = { bucket: 'visitor-photos' as const, path: `${visitorId}/${mediaId}.jpg` };
    const bytes = await jpeg(10);

    await storage.put(object, bytes);
    expect(fake.objects.get(`visitor-photos/${visitorId}/${mediaId}.jpg`)).toEqual({
      bytes,
      contentType: 'image/jpeg',
    });
    expect(await storage.get(object)).toEqual(bytes);
    // Every call carries the service-role key; the buckets are never read anonymously.
    expect(fake.requests.every((r) => r.authorized)).toBe(true);

    const url = await storage.signedUrl(object, 120);
    expect(url).toMatch(
      new RegExp(
        `^${fake.url}/storage/v1/object/sign/visitor-photos/${visitorId}/${mediaId}\\.jpg\\?token=`,
      ),
    );
    const grant = [...fake.signed.values()][0];
    expect(grant && Math.round((grant.expiresAt - Date.now()) / 1000)).toBeGreaterThanOrEqual(119);
    expect(grant && Math.round((grant.expiresAt - Date.now()) / 1000)).toBeLessThanOrEqual(120);
    const viaUrl = await fetch(url as string);
    expect(viaUrl.status).toBe(200);
    expect(Buffer.from(await viaUrl.arrayBuffer())).toEqual(bytes);

    // Without the key or a signed URL, nothing is readable.
    const anon = await fetch(
      `${fake.url}/storage/v1/object/authenticated/${object.bucket}/${object.path}`,
    );
    expect(anon.ok).toBe(false);

    await storage.delete(object);
    expect(fake.objects.size).toBe(0);
    expect(await storage.get(object)).toBeNull();
    expect(await storage.signedUrl(object, 120)).toBeNull();
    await expect(storage.delete(object)).resolves.toBeUndefined(); // already gone: fine
  });

  it('uses the §9.10 bucket for each kind and refuses anything else', async () => {
    const storage = new SupabaseMediaStorage(fake.url, KEY);
    const id = randomUUID();
    await storage.put({ bucket: 'gate-photos', path: `${id}/2026/10/${id}.jpg` }, await jpeg(20));
    await storage.put({ bucket: 'resident-docs', path: `${id}/${id}.jpg` }, await jpeg(30));
    expect([...fake.objects.keys()].sort()).toEqual(
      [`gate-photos/${id}/2026/10/${id}.jpg`, `resident-docs/${id}/${id}.jpg`].sort(),
    );
    await expect(
      storage.put({ bucket: 'public' as never, path: `${id}.jpg` }, await jpeg(40)),
    ).rejects.toThrow('invalid media object');
    await expect(
      storage.put({ bucket: 'gate-photos', path: `../${id}.jpg` }, await jpeg(40)),
    ).rejects.toThrow('invalid media object');
  });

  it('a storage outage is an error, not a silent "missing photo"', async () => {
    const storage = new SupabaseMediaStorage(fake.url, 'wrong-key');
    const object = {
      bucket: 'visitor-photos' as const,
      path: `${randomUUID()}/${randomUUID()}.jpg`,
    };
    await expect(storage.put(object, await jpeg(50))).rejects.toThrow(
      /media storage upload failed: HTTP 400/,
    );
    const down = new SupabaseMediaStorage('http://127.0.0.1:9', KEY);
    await expect(down.get(object)).rejects.toThrow();
  });
});

describe('which store the API uses (§9.10, DEC-021)', () => {
  const base = {
    MEDIA_STORAGE_DIR: '.media-test',
    SUPABASE_URL: undefined,
    SUPABASE_SERVICE_ROLE_KEY: undefined,
  };
  it('local disk only when APP_ENV=local; Supabase whenever it is configured', () => {
    expect(createMediaStorage({ ...base, APP_ENV: 'local' })).toBeInstanceOf(LocalDiskMediaStorage);
    for (const APP_ENV of ['staging', 'production'] as const) {
      expect(() => createMediaStorage({ ...base, APP_ENV })).toThrow(
        /Refusing to store photos on local disk/,
      );
      expect(
        createMediaStorage({
          ...base,
          APP_ENV,
          SUPABASE_URL: fake.url,
          SUPABASE_SERVICE_ROLE_KEY: KEY,
        }),
      ).toBeInstanceOf(SupabaseMediaStorage);
    }
  });

  it('buildApp refuses to boot outside local with local-disk storage', async () => {
    await expect(
      buildTestApp(new FakeClock(new Date()), {
        env: {
          APP_ENV: 'staging',
          SUPABASE_URL: fake.url,
          SUPABASE_SERVICE_ROLE_KEY: KEY,
          TURNSTILE_SECRET: 'x',
        },
        mediaStorage: new LocalDiskMediaStorage('.media-test'),
      }),
    ).rejects.toThrow(/LocalDiskMediaStorage is for APP_ENV=local only/);
  });
});

describe('the API end to end on Supabase storage', () => {
  let app: FastifyInstance;
  const clock = new FakeClock(new Date('2026-10-12T06:30:00.000Z'));
  beforeEach(async () => {
    await resetAllHavenTables();
    app = await buildTestApp(clock, { mediaStorage: new SupabaseMediaStorage(fake.url, KEY) });
  });
  afterEach(async () => {
    await app.close();
  });

  it('a profile photo lands in visitor-photos/{visitorId}/{mediaId}.jpg and its URL redirects to a 120 s signed URL', async () => {
    const visitorId = await makeVisitor(db, '+919812366601', 'female', { complete: false });
    const auth = `Bearer ${await issueToken(clock, { type: 'visitor', id: visitorId })}`;
    const up = await supertest(app.server)
      .post('/v1/me/profile-photo')
      .set('Authorization', auth)
      .attach('photo', await jpeg(60), 'p.jpg');
    expect(up.status).toBe(200);
    const photoId = up.body.photoId as string;
    expect([...fake.objects.keys()]).toEqual([`visitor-photos/${visitorId}/${photoId}.jpg`]);

    // The URL every serializer hands out for this photo (MediaUrlSigner, 120 s).
    const signedApiUrl = new URL(
      new MediaUrlSigner(JWT_SECRET, API_BASE_URL, clock).sign(photoId).url,
    );
    const res = await supertest(app.server).get(`${signedApiUrl.pathname}${signedApiUrl.search}`);
    expect(res.status).toBe(302);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers.location).toMatch(
      new RegExp(
        `^${fake.url}/storage/v1/object/sign/visitor-photos/${visitorId}/${photoId}\\.jpg\\?token=`,
      ),
    );
    const img = await fetch(res.headers.location as string);
    expect(img.status).toBe(200);
    expect(img.headers.get('content-type')).toBe('image/jpeg');
  });
});
