import type { FastifyInstance } from 'fastify';
import sharp from 'sharp';
import supertest from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { FakeClock } from '../src/lib/clock.js';
import { resetAllHavenTables } from './db-test-helper.js';
import { buildTestApp, db, issueToken, MemoryMediaStorage } from './app-test-helpers.js';
import { hostelWorld, type HostelWorld } from './staff-fixtures.js';

/**
 * FR-08: "Guests and residents can view and edit their name and retake their profile
 * photo (re-verification not required for guests; resident photo changes are logged)."
 * FINAL-QA-REPORT item 11.
 */

const NOW = new Date('2026-10-12T06:30:00.000Z');
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
});

const photo = (shade: number) =>
  sharp({
    create: { width: 160, height: 160, channels: 3, background: { r: shade, g: 90, b: 40 } },
  })
    .jpeg()
    .toBuffer();

const media = (id: string) =>
  db
    .selectFrom('haven.media')
    .select(['bucket', 'path', 'deleted_at'])
    .where('id', '=', id)
    .executeTakeFirstOrThrow();

describe('guests (FR-08)', () => {
  it('see their photo, edit their name, and retake the photo; the old one is deleted', async () => {
    const auth = `Bearer ${await issueToken(clock, { type: 'visitor', id: w.visitorId })}`;
    const first = await supertest(app.server)
      .post('/v1/me/profile-photo')
      .set('Authorization', auth)
      .attach('photo', await photo(10), 'p.jpg');
    expect(first.status).toBe(200);

    const me = await supertest(app.server).get('/v1/me').set('Authorization', auth);
    expect(me.body.profilePhoto.url).toMatch(new RegExp(`/v1/media/${first.body.photoId}\\?exp=`));

    const rename = await supertest(app.server)
      .patch('/v1/me')
      .set('Authorization', auth)
      .send({ fullName: 'Asha R. Kumar' });
    expect(rename.status).toBe(204);

    const retake = await supertest(app.server)
      .post('/v1/me/profile-photo')
      .set('Authorization', auth)
      .attach('photo', await photo(200), 'p.jpg');
    expect(retake.status).toBe(200);

    const after = await supertest(app.server).get('/v1/me').set('Authorization', auth);
    expect(after.body.fullName).toBe('Asha R. Kumar');
    expect(after.body.profilePhoto.url).toContain(`/v1/media/${retake.body.photoId}?`);
    // No re-verification for guests: the profile stays complete.
    expect(after.body.profileComplete).toBe(true);

    const old = await media(first.body.photoId as string);
    expect(old.deleted_at).not.toBeNull();
    expect(storage.objects.has(`${old.bucket}/${old.path}`)).toBe(false);
  });
});

describe('residents (FR-08)', () => {
  async function verifiedWithSelfie() {
    const auth = `Bearer ${await issueToken(clock, { type: 'user', id: w.residentId })}`;
    const bytes = await photo(60);
    const m = await db
      .insertInto('haven.media')
      .values({
        kind: 'resident_selfie',
        bucket: 'resident-docs',
        path: `${w.residentId}/selfie-1.jpg`,
        sha256: Buffer.from('selfie-1'),
        bytes: bytes.length,
        owner_user_id: w.residentId,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await storage.put({ bucket: 'resident-docs', path: `${w.residentId}/selfie-1.jpg` }, bytes);
    await db
      .updateTable('haven.residents')
      .set({ selfie_media_id: m.id })
      .where('user_id', '=', w.residentId)
      .execute();
    return { auth, oldSelfie: m.id };
  }

  it('a verified resident retakes their selfie; the change is in the audit log and the old photo is gone', async () => {
    const { auth, oldSelfie } = await verifiedWithSelfie();
    const before = await supertest(app.server).get('/v1/me').set('Authorization', auth);
    expect(before.body.profilePhoto.url).toContain(`/v1/media/${oldSelfie}?`);

    const res = await supertest(app.server)
      .post('/v1/residents/me/documents')
      .set('Authorization', auth)
      .field('kind', 'selfie')
      .attach('photo', await photo(220), 'selfie.jpg');
    expect(res.status).toBe(200);
    const newSelfie = res.body.photoId as string;

    const row = await db
      .selectFrom('haven.residents')
      .select(['selfie_media_id', 'status'])
      .where('user_id', '=', w.residentId)
      .executeTakeFirstOrThrow();
    // Still verified: the warden isn't asked again, but the change is logged.
    expect(row).toEqual({ selfie_media_id: newSelfie, status: 'verified' });
    const logged = await db
      .selectFrom('haven.audit_log')
      .select(['actor_type', 'actor_id', 'before', 'after'])
      .where('entity', '=', 'residents')
      .where('action', '=', 'residents.update')
      .execute();
    expect(
      logged.some(
        (l) =>
          l.actor_type === 'user' &&
          l.actor_id === w.residentId &&
          (l.before as { selfie_media_id?: string }).selfie_media_id === oldSelfie &&
          (l.after as { selfie_media_id?: string }).selfie_media_id === newSelfie,
      ),
    ).toBe(true);

    const old = await media(oldSelfie);
    expect(old.deleted_at).not.toBeNull();
    expect(storage.objects.has(`resident-docs/${w.residentId}/selfie-1.jpg`)).toBe(false);

    const after = await supertest(app.server).get('/v1/me').set('Authorization', auth);
    expect(after.body.profilePhoto.url).toContain(`/v1/media/${newSelfie}?`);
  });

  it('edits their name; the ID card can no longer be uploaded once verified', async () => {
    const { auth } = await verifiedWithSelfie();
    const rename = await supertest(app.server)
      .patch('/v1/me')
      .set('Authorization', auth)
      .send({ fullName: 'Priya Sharma' });
    expect(rename.status).toBe(204);
    expect(
      (await supertest(app.server).get('/v1/me').set('Authorization', auth)).body.fullName,
    ).toBe('Priya Sharma');

    const idCard = await supertest(app.server)
      .post('/v1/residents/me/documents')
      .set('Authorization', auth)
      .field('kind', 'id_card')
      .attach('photo', await photo(240), 'id.jpg');
    expect(idCard.status).toBe(409);
  });
});
