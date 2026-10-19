import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import sharp from 'sharp';
import supertest from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CONSENT_VERSION } from '@haven/shared';
import { FakeClock } from '../src/lib/clock.js';
import { sha256 } from '../src/lib/crypto.js';
import { resetAllHavenTables } from './db-test-helper.js';
import { buildTestApp, db, issueToken, scanAndPhoto } from './app-test-helpers.js';
import { hostelWorld, seedVisit, type HostelWorld } from './staff-fixtures.js';
import { makeVisitor } from './visits-fixtures.js';

/**
 * FINAL-QA-REPORT D-05. FR-02 "First-time guests provide full name, gender, confirm
 * they are 18+, accept the privacy notice, and take a profile selfie"; §16.3 "explicit
 * checkbox ... Store consent_version and consent_at"; §12.4 POST /me/consent; §12.2
 * PROFILE_INCOMPLETE (403) "Guest must finish profile first".
 */

const NOW = new Date('2026-10-12T06:30:00.000Z'); // 12:00 IST
let clock: FakeClock;
let app: FastifyInstance;
let w: HostelWorld;

beforeAll(async () => {
  clock = new FakeClock(NOW);
  app = await buildTestApp(clock);
});
afterAll(async () => {
  await app.close();
});
beforeEach(async () => {
  await resetAllHavenTables();
  clock.set(NOW);
  w = await hostelWorld();
});

const bearer = async (type: 'user' | 'visitor', id: string) =>
  `Bearer ${await issueToken(clock, { type, id })}`;

async function newGuest(phone = '+919812355501') {
  const id = await makeVisitor(db, phone, 'undisclosed', { complete: false });
  return { id, auth: await bearer('visitor', id) };
}

describe('POST /v1/me/consent (§12.4, §16.3)', () => {
  it('stores the notice version, the time and 18+; only the current version is accepted', async () => {
    const g = await newGuest();
    const stale = await supertest(app.server)
      .post('/v1/me/consent')
      .set('Authorization', g.auth)
      .send({ version: 'privacy-1999-01-01', isAdult: true });
    expect(stale.status).toBe(400);
    const notAdult = await supertest(app.server)
      .post('/v1/me/consent')
      .set('Authorization', g.auth)
      .send({ version: CONSENT_VERSION, isAdult: false });
    expect(notAdult.status).toBe(400);

    const ok = await supertest(app.server)
      .post('/v1/me/consent')
      .set('Authorization', g.auth)
      .send({ version: CONSENT_VERSION, isAdult: true });
    expect(ok.status).toBe(204);
    const row = await db
      .selectFrom('haven.visitors')
      .select(['consent_version', 'consent_at', 'is_adult_confirmed'])
      .where('id', '=', g.id)
      .executeTakeFirstOrThrow();
    expect(row).toEqual({
      consent_version: CONSENT_VERSION,
      consent_at: NOW,
      is_adult_confirmed: true,
    });
  });
});

describe('profileComplete = name + 18+ + consent + profile photo (FR-02)', () => {
  it('GET /me says incomplete until every G-04/G-05 step is done', async () => {
    const g = await newGuest();
    const me = () => supertest(app.server).get('/v1/me').set('Authorization', g.auth);
    expect((await me()).body.profileComplete).toBe(false);

    await supertest(app.server)
      .patch('/v1/me')
      .set('Authorization', g.auth)
      .send({ fullName: 'Asha Rani', gender: 'female' });
    expect((await me()).body.profileComplete).toBe(false);
    await supertest(app.server)
      .post('/v1/me/consent')
      .set('Authorization', g.auth)
      .send({ version: CONSENT_VERSION, isAdult: true });
    expect((await me()).body.profileComplete).toBe(false);
    const photo = await sharp({
      create: { width: 200, height: 200, channels: 3, background: { r: 9, g: 99, b: 199 } },
    })
      .jpeg()
      .toBuffer();
    const up = await supertest(app.server)
      .post('/v1/me/profile-photo')
      .set('Authorization', g.auth)
      .attach('photo', photo, 'p.jpg');
    expect(up.status).toBe(200);
    expect((await me()).body).toMatchObject({
      profileComplete: true,
      consentVersion: CONSENT_VERSION,
    });
  });
});

describe('PROFILE_INCOMPLETE (403) is enforced by the API, not just the app', () => {
  it('a guest without a finished profile cannot request entry (walk-in)', async () => {
    const g = await newGuest();
    const scan = await scanAndPhoto(app, clock, {
      gate: w.gate,
      bearer: g.auth.replace('Bearer ', ''),
    });
    const res = await supertest(app.server)
      .post(`/v1/scan-sessions/${scan.sessionId}/walk-in`)
      .set('Idempotency-Key', randomUUID())
      .set('Authorization', g.auth)
      .set('X-Scan-Nonce', scan.nonce)
      .send({ hostId: w.residentId, type: 'day', durationMinutes: 60, photoId: scan.photoId });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('PROFILE_INCOMPLETE');
    expect(await db.selectFrom('haven.visits').select('id').execute()).toEqual([]);
  });

  it('a guest without a finished profile cannot check in to an approved visit', async () => {
    const g = await newGuest();
    const visitId = await seedVisit({
      hostelId: w.hostelId,
      hostId: w.residentId,
      visitorId: g.id,
      status: 'approved',
      windowStart: new Date(NOW.getTime() - 600_000),
      windowEnd: new Date(NOW.getTime() + 3_600_000),
    });
    const scan = await scanAndPhoto(app, clock, {
      gate: w.gate,
      bearer: g.auth.replace('Bearer ', ''),
    });
    const res = await supertest(app.server)
      .post(`/v1/scan-sessions/${scan.sessionId}/check-in`)
      .set('Authorization', g.auth)
      .set('X-Scan-Nonce', scan.nonce)
      .set('Idempotency-Key', crypto.randomUUID())
      .send({ visitId, photoId: scan.photoId });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('PROFILE_INCOMPLETE');
  });

  it('claiming an invite: wrong phone is INVITE_PHONE_MISMATCH first; right phone needs a finished profile', async () => {
    const g = await newGuest('+919812355502');
    const token = 'invite-token-profile-test-0123456789';
    const visitId = await seedVisit({
      hostelId: w.hostelId,
      hostId: w.residentId,
      visitorId: null,
      status: 'approved',
      windowStart: new Date(NOW.getTime() + 3_600_000),
      windowEnd: new Date(NOW.getTime() + 7_200_000),
    });
    await db
      .updateTable('haven.visits')
      .set({ invite_token_hash: sha256(token), invited_phone: '+919812355502' })
      .where('id', '=', visitId)
      .execute();

    const other = await newGuest('+919812355503');
    const mismatch = await supertest(app.server)
      .post(`/v1/invites/${token}/claim`)
      .set('Authorization', other.auth)
      .send({});
    expect(mismatch.body.error.code).toBe('INVITE_PHONE_MISMATCH');

    const early = await supertest(app.server)
      .post(`/v1/invites/${token}/claim`)
      .set('Authorization', g.auth)
      .send({});
    expect(early.status).toBe(403);
    expect(early.body.error.code).toBe('PROFILE_INCOMPLETE');
    const unbound = await db
      .selectFrom('haven.visits')
      .select('visitor_id')
      .where('id', '=', visitId)
      .executeTakeFirstOrThrow();
    expect(unbound.visitor_id).toBeNull();

    // Finish the profile, then the claim goes through.
    const done = await makeVisitor(db, '+919812355509');
    void done;
    await db
      .updateTable('haven.visitors')
      .set({
        full_name: 'Asha Rani',
        is_adult_confirmed: true,
        consent_version: CONSENT_VERSION,
        consent_at: NOW.toISOString(),
      })
      .where('id', '=', g.id)
      .execute();
    const media = await db
      .insertInto('haven.media')
      .values({
        kind: 'visitor_profile',
        bucket: 'visitor-photos',
        path: `${g.id}/p1.jpg`,
        sha256: Buffer.from('x'),
        bytes: 1,
        owner_visitor_id: g.id,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await db
      .updateTable('haven.visitors')
      .set({ profile_media_id: media.id })
      .where('id', '=', g.id)
      .execute();
    const claimed = await supertest(app.server)
      .post(`/v1/invites/${token}/claim`)
      .set('Authorization', g.auth)
      .send({});
    expect(claimed.status).toBe(200);
  });
});

describe('residents record consent on submit (R-03, §16.3)', () => {
  it('submit needs the consent flag and current version, and stores both', async () => {
    const { pendingResident } = await import('./staff-fixtures.js');
    void pendingResident;
    // A resident with a draft ready to submit.
    const userId = (
      await db
        .insertInto('haven.users')
        .values({
          google_sub: 'consent-r',
          email: 'consent-r@haven.test',
          full_name: 'Riya Resident',
          phone: '+919812355520',
          phone_verified_at: NOW.toISOString(),
        })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id;
    const media = async (kind: 'resident_id_card' | 'resident_selfie') =>
      (
        await db
          .insertInto('haven.media')
          .values({
            kind,
            bucket: 'resident-docs',
            path: `${userId}/${kind.replace(/_/g, '-')}.jpg`,
            sha256: Buffer.from(kind),
            bytes: 1,
            owner_user_id: userId,
          })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id;
    await db
      .insertInto('haven.residents')
      .values({
        user_id: userId,
        hostel_id: w.hostelId,
        claimed_room: '204',
        id_card_media_id: await media('resident_id_card'),
        selfie_media_id: await media('resident_selfie'),
      })
      .execute();
    const auth = await bearer('user', userId);

    const without = await supertest(app.server)
      .post('/v1/residents/me/submit')
      .set('Authorization', auth)
      .send({});
    expect(without.status).toBe(400);
    const ok = await supertest(app.server)
      .post('/v1/residents/me/submit')
      .set('Authorization', auth)
      .send({ consent: true, consentVersion: CONSENT_VERSION });
    expect(ok.status).toBe(204);
    const row = await db
      .selectFrom('haven.residents')
      .select(['consent_version', 'consent_at', 'status'])
      .where('user_id', '=', userId)
      .executeTakeFirstOrThrow();
    expect(row).toEqual({ consent_version: CONSENT_VERSION, consent_at: NOW, status: 'pending' });
  });
});
