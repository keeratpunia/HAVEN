import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import sharp from 'sharp';
import supertest from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { FakeClock } from '../src/lib/clock.js';
import { LocalDiskMediaStorage } from '../src/gate/media.js';
import { MediaUrlSigner, SIGNED_URL_TTL_SECONDS } from '../src/media/signing.js';
import { resetAllHavenTables } from './db-test-helper.js';
import {
  API_BASE_URL,
  buildTestApp,
  db,
  issueToken,
  JWT_SECRET,
  MemoryMediaStorage,
} from './app-test-helpers.js';
import { grant, hostelWorld, makeUser, seedVisit, type HostelWorld } from './staff-fixtures.js';
import { makeVisitor } from './visits-fixtures.js';

/**
 * Media pipeline against SDD §9.4 and §9.10, and photo access against §3.3: magic
 * bytes, size, re-encoding, metadata stripping, rotation, reuse, signed-URL expiry,
 * and who may get a photo URL at all.
 */

const NOW = new Date('2026-10-18T10:30:00.000Z');
let clock: FakeClock;
let app: FastifyInstance;
let storage: MemoryMediaStorage;
let w: HostelWorld;

beforeAll(async () => {
  clock = new FakeClock(NOW);
  storage = new MemoryMediaStorage();
  app = await buildTestApp(clock, { mediaStorage: storage });
});
afterAll(async () => {
  await app.close();
});
beforeEach(async () => {
  await resetAllHavenTables();
  storage.objects.clear();
  clock.set(NOW);
  w = await hostelWorld();
  uploader = await makeVisitor(db, undefined, 'female', { complete: false });
});

const solid = (width: number, height: number, shade = 120) =>
  sharp({ create: { width, height, channels: 3, background: { r: shade, g: 80, b: 40 } } });

/** Uploads come from a guest taking their first profile photo (no photo yet). */
let uploader: string;
async function upload(bytes: Buffer, filename = 'photo.jpg', visitorId = uploader) {
  const token = await issueToken(clock, { type: 'visitor', id: visitorId });
  return supertest(app.server)
    .post('/v1/me/profile-photo')
    .set('Authorization', `Bearer ${token}`)
    .attach('photo', bytes, { filename, contentType: 'image/jpeg' });
}

async function stored(photoId: string): Promise<Buffer> {
  const row = await db
    .selectFrom('haven.media')
    .select(['bucket', 'path'])
    .where('id', '=', photoId)
    .executeTakeFirstOrThrow();
  const bytes = await storage.get({ bucket: row.bucket as 'visitor-photos', path: row.path });
  if (!bytes) throw new Error('not stored');
  return bytes;
}

describe('upload pipeline (SDD §9.4)', () => {
  it('refuses a file over 3 MB', async () => {
    const big = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(3 * 1024 * 1024)]);
    const res = await upload(big);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('PHOTO_INVALID');
    expect(
      await db
        .selectFrom('haven.media')
        .select('id')
        .where('owner_visitor_id', '=', uploader)
        .execute(),
    ).toEqual([]);
  });

  it('refuses a non-image renamed .jpg (magic bytes, not the MIME header)', async () => {
    for (const fake of [
      Buffer.from('<?php system($_GET["c"]); ?>'),
      Buffer.from('<html><script>alert(1)</script></html>'),
      Buffer.from('GIF89a\x01\x00\x01\x00'),
    ]) {
      const res = await upload(fake, 'innocent.jpg');
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('PHOTO_INVALID');
    }
    expect(storage.objects.size).toBe(0);
  });

  it('accepts a PNG and stores it re-encoded as JPEG, at most 720 px', async () => {
    const png = await solid(1600, 1200).png().toBuffer();
    const res = await upload(png, 'selfie.png');
    expect(res.status).toBe(200);
    const out = await stored(res.body.photoId);
    expect([...out.subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff]);
    const meta = await sharp(out).metadata();
    expect(meta).toMatchObject({ format: 'jpeg', width: 720, height: 540 });
  });

  it('strips EXIF, including GPS, from the stored file', async () => {
    const tagged = await solid(400, 400)
      .jpeg()
      .withExif({
        IFD0: { Make: 'TestPhone', Copyright: 'someone' },
        IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '12/1 58/1 0/1' },
      })
      .toBuffer();
    expect((await sharp(tagged).metadata()).exif).toBeDefined();
    const res = await upload(tagged);
    expect(res.status).toBe(200);
    const meta = await sharp(await stored(res.body.photoId)).metadata();
    expect(meta.exif).toBeUndefined();
    expect(meta.icc).toBeUndefined();
    expect(meta.xmp).toBeUndefined();
  });

  it('applies the EXIF orientation before stripping it', async () => {
    // 400×200 pixels tagged "rotate 90° clockwise" → stored upright as 200×400.
    const sideways = await solid(400, 200).jpeg().withMetadata({ orientation: 6 }).toBuffer();
    const res = await upload(sideways);
    expect(res.status).toBe(200);
    const meta = await sharp(await stored(res.body.photoId)).metadata();
    expect({ width: meta.width, height: meta.height, orientation: meta.orientation }).toEqual({
      width: 200,
      height: 400,
      orientation: undefined,
    });
  });

  it('refuses an image that would decode to more than 40 megapixels', async () => {
    const huge = await solid(7000, 6000).png({ compressionLevel: 9 }).toBuffer();
    expect(huge.length).toBeLessThan(3 * 1024 * 1024);
    const res = await upload(huge, 'bomb.png');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('PHOTO_INVALID');
  });

  it('refuses the same photo twice for one visitor (PHOTO_REUSED), but not for another', async () => {
    const photo = await solid(300, 300, 200).jpeg().toBuffer();
    expect((await upload(photo)).status).toBe(200);
    const again = await upload(photo);
    expect(again.status).toBe(400);
    expect(again.body.error.code).toBe('PHOTO_REUSED');
    expect((await upload(photo, 'p.jpg', await makeVisitor(db))).status).toBe(200);
  });

  it('stores under the §9.10 private bucket and path layout', async () => {
    const res = await upload(await solid(300, 300, 90).jpeg().toBuffer());
    const row = await db
      .selectFrom('haven.media')
      .select(['bucket', 'path', 'kind'])
      .where('id', '=', res.body.photoId)
      .executeTakeFirstOrThrow();
    expect(row).toEqual({
      bucket: 'visitor-photos',
      kind: 'visitor_profile',
      path: `${uploader}/${res.body.photoId}.jpg`,
    });
    expect([...storage.objects.keys()]).toEqual([`visitor-photos/${row.path}`]);
  });
});

describe('SA-17: the same photo uploaded twice at once', () => {
  it('only one of several parallel identical uploads is stored; the rest are PHOTO_REUSED', async () => {
    const photo = await solid(300, 300, 77).jpeg().toBuffer();
    const results = await Promise.all(Array.from({ length: 6 }, () => upload(photo)));
    const statuses = results.map((r) => r.status).sort();
    expect(statuses.filter((x) => x === 200)).toHaveLength(1);
    expect(
      results.filter((r) => r.status === 400).every((r) => r.body.error.code === 'PHOTO_REUSED'),
    ).toBe(true);
    const rows = await db
      .selectFrom('haven.media')
      .select('id')
      .where('owner_visitor_id', '=', uploader)
      .execute();
    expect(rows).toHaveLength(1);
  });
});

describe('local storage keys can’t escape their bucket', () => {
  it('rejects traversal and unknown buckets', async () => {
    const disk = new LocalDiskMediaStorage(mkdtempSync(path.join(tmpdir(), 'haven-media-')));
    const bytes = Buffer.from('x');
    await expect(
      disk.put({ bucket: 'gate-photos', path: '../../etc/passwd.jpg' }, bytes),
    ).rejects.toThrow();
    await expect(
      disk.put({ bucket: 'gate-photos', path: 'a/../../b.jpg' }, bytes),
    ).rejects.toThrow();
    await expect(
      disk.put({ bucket: '../x' as 'gate-photos', path: 'a.jpg' }, bytes),
    ).rejects.toThrow();
    await expect(
      disk.put({ bucket: 'gate-photos', path: 'C:\\evil.jpg' }, bytes),
    ).rejects.toThrow();
    await disk.put({ bucket: 'gate-photos', path: 'h1/2026/10/m1.jpg' }, bytes);
    expect(await disk.get({ bucket: 'gate-photos', path: 'h1/2026/10/m1.jpg' })).toEqual(bytes);
  });
});

describe('signed URLs (SDD §9.10: 120 s, per response)', () => {
  it('a URL works until 120 s, then 404; a URL for one photo can’t fetch another', async () => {
    const a = await upload(await solid(300, 300, 10).jpeg().toBuffer());
    // Another guest's photo: a second upload by the same guest is a retake (FR-08) and
    // replaces the first.
    const b = await upload(
      await solid(300, 300, 250).jpeg().toBuffer(),
      'photo.jpg',
      await makeVisitor(db, undefined, 'female', { complete: false }),
    );
    const signer = new MediaUrlSigner(JWT_SECRET, API_BASE_URL, clock);
    const signed = signer.sign(a.body.photoId);
    const rel = signed.url.replace(API_BASE_URL, '');

    clock.advance((SIGNED_URL_TTL_SECONDS - 1) * 1000);
    const ok = await supertest(app.server).get(rel);
    expect(ok.status).toBe(200);
    expect(ok.headers['content-type']).toBe('image/jpeg');

    const swapped = rel.replace(a.body.photoId, b.body.photoId);
    expect((await supertest(app.server).get(swapped)).status).toBe(404);
    expect((await supertest(app.server).get(rel.replace(/sig=[^&]+/, 'sig=forged'))).status).toBe(
      404,
    );

    clock.advance(2000);
    const late = await supertest(app.server).get(rel);
    expect(late.status).toBe(404);
  });
});

describe('who gets photo URLs (SDD §3.3)', () => {
  async function insideVisitWithPhoto(world: HostelWorld) {
    const res = await upload(await solid(300, 300, 33).jpeg().toBuffer(), 'p.jpg', world.visitorId);
    await db
      .updateTable('haven.visitors')
      .set({ profile_media_id: res.body.photoId })
      .where('id', '=', world.visitorId)
      .execute();
    return seedVisit({
      hostelId: world.hostelId,
      hostId: world.residentId,
      visitorId: world.visitorId,
      status: 'inside',
      windowStart: new Date(NOW.getTime() - 3_600_000),
      windowEnd: new Date(NOW.getTime() + 3_600_000),
    });
  }
  const bearer = async (type: 'user' | 'visitor', id: string) =>
    `Bearer ${await issueToken(clock, { type, id })}`;

  it('the host and their warden see the photo; another resident, another hostel’s warden and the office do not', async () => {
    const visitId = await insideVisitWithPhoto(w);
    const other = await hostelWorld();
    const strangerResident = other.residentId;
    const superAdmin = await makeUser('Super');
    await grant(superAdmin, 'super_admin', null);

    const host = await supertest(app.server)
      .get(`/v1/visits/${visitId}`)
      .set('Authorization', await bearer('user', w.residentId));
    expect(host.status).toBe(200);
    expect(JSON.stringify(host.body)).toMatch(/\/v1\/media\//);

    const warden = await supertest(app.server)
      .get(`/v1/admin/visits/${visitId}`)
      .set('Authorization', await bearer('user', w.wardenId))
      .set('X-Hostel-Id', w.hostelId);
    expect(warden.status).toBe(200);
    expect(JSON.stringify(warden.body)).toMatch(/\/v1\/media\//);

    const cross = await supertest(app.server)
      .get(`/v1/visits/${visitId}`)
      .set('Authorization', await bearer('user', strangerResident));
    expect(cross.status).toBe(404);
    expect(JSON.stringify(cross.body)).not.toMatch(/\/v1\/media\//);

    const otherWarden = await supertest(app.server)
      .get(`/v1/admin/visits/${visitId}`)
      .set('Authorization', await bearer('user', other.wardenId))
      .set('X-Hostel-Id', other.hostelId);
    expect(otherWarden.status).toBe(404);
    const otherWardenWrongScope = await supertest(app.server)
      .get(`/v1/admin/visits/${visitId}`)
      .set('Authorization', await bearer('user', other.wardenId))
      .set('X-Hostel-Id', w.hostelId);
    expect(otherWardenWrongScope.status).toBe(403);

    const office = await supertest(app.server)
      .get(`/v1/admin/visits/${visitId}`)
      .set('Authorization', await bearer('user', w.officeId))
      .set('X-Hostel-Id', w.hostelId);
    expect(office.status).toBe(403);
    expect(office.body.error.code).toBe('FORBIDDEN');
    const officeCharges = await supertest(app.server)
      .get('/v1/admin/charges')
      .set('Authorization', await bearer('user', w.officeId))
      .set('X-Hostel-Id', w.hostelId);
    expect(JSON.stringify(officeCharges.body)).not.toMatch(/\/v1\/media\/|guestPhoto/);

    const guest = await supertest(app.server)
      .get(`/v1/visits/${visitId}`)
      .set('Authorization', await bearer('visitor', other.visitorId));
    expect(guest.status).toBe(404);
  });
});
