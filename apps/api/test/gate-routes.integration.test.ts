import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import supertest from 'supertest';
import sharp from 'sharp';
import { beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { __resetEnvCacheForTests, loadEnv } from '../src/config.js';
import { getTestDb, resetAllHavenTables } from './db-test-helper.js';
import { makeHostel, makeVerifiedHost, makeVisitor } from './visits-fixtures.js';
import { FakeClock } from '../src/lib/clock.js';
import { FakeGoogleIdTokenVerifier } from '../src/auth/google.js';
import { createLogger } from '../src/lib/logger.js';
import { encryptAesGcm, parseDataEncryptionKey, randomSecret } from '../src/lib/crypto.js';
import { signAccessToken } from '../src/auth/jwt.js';
import { createSession } from '../src/auth/sessions.js';
import { generateGateToken, STEP_MS } from '../src/gate/token.js';
import { __resetPolicyRegistryForTests } from '../src/auth/policy.js';
import { registerVisitPolicies, __resetVisitPoliciesForTests } from '../src/visits/policy.js';
import { registerGatePolicies, __resetGatePoliciesForTests } from '../src/gate/policy.js';
import { __resetAuthPoliciesForTests } from '../src/auth/policy-rules.js';
import type { MediaStorage } from '../src/gate/media.js';
import { TEST_DATABASE_URL } from './pg-test-constants.js';

const JWT_SECRET = Buffer.alloc(32, 1).toString('base64');
const OTP_PEPPER = Buffer.alloc(32, 2).toString('base64');
const DATA_ENCRYPTION_KEY_B64 = Buffer.alloc(32, 9).toString('base64');
const DATA_ENCRYPTION_KEY = parseDataEncryptionKey(DATA_ENCRYPTION_KEY_B64);
const fakeMediaStorage: MediaStorage = {
  put: async () => undefined,
  get: async () => null,
  delete: async () => undefined,
};

const db = getTestDb();
const NOW = new Date('2026-10-12T10:42:00.000Z');
const GATE_LAT = 12.9716;
const GATE_LNG = 77.5946;

function testEnv() {
  __resetEnvCacheForTests();
  return loadEnv({
    APP_ENV: 'local',
    DATABASE_URL: TEST_DATABASE_URL,
    DATABASE_DIRECT_URL: TEST_DATABASE_URL,
    JWT_SECRET,
    OTP_PEPPER,
    GOOGLE_CLIENT_IDS: 'test-client-id',
    DATA_ENCRYPTION_KEY: DATA_ENCRYPTION_KEY_B64,
    LOG_LEVEL: 'silent',
  });
}

async function makeGateWithSecret(hostelId: string) {
  const secret = randomSecret(32);
  const code = `GH${Math.random().toString(36).slice(2, 6).toUpperCase().padEnd(4, '0')}`.slice(
    0,
    6,
  );
  const row = await db
    .insertInto('haven.gates')
    .values({
      hostel_id: hostelId,
      code,
      lat: GATE_LAT,
      lng: GATE_LNG,
      radius_m: 50,
      max_accuracy_m: 75,
      secret_enc: encryptAesGcm(secret, DATA_ENCRYPTION_KEY),
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return { gateId: row.id, code, secret };
}

async function issueToken(clock: FakeClock, principal: { type: 'visitor' | 'user'; id: string }) {
  const sessionId = await db.transaction().execute((trx) =>
    createSession(
      trx,
      {
        principalType: principal.type,
        principalId: principal.id,
        client: 'web',
        userAgent: null,
        ip: null,
      },
      clock,
    ),
  );
  return signAccessToken(
    { sub: principal.id, typ: principal.type, sid: sessionId.sessionId, roles: [] },
    JWT_SECRET,
  );
}

async function tinyJpeg(): Promise<Buffer> {
  return sharp({
    create: { width: 20, height: 20, channels: 3, background: { r: 10, g: 20, b: 30 } },
  })
    .jpeg()
    .toBuffer();
}

function goodLocation() {
  return { lat: GATE_LAT, lng: GATE_LNG, accuracy: 10, fixAgeMs: 1000 };
}

describe('gate routes (SDD §9.3, §12.8) end to end', () => {
  let app: FastifyInstance;
  let clock: FakeClock;

  beforeEach(async () => {
    await resetAllHavenTables();
    __resetPolicyRegistryForTests();
    __resetVisitPoliciesForTests();
    __resetGatePoliciesForTests();
    __resetAuthPoliciesForTests();
    registerVisitPolicies();
    registerGatePolicies();
    clock = new FakeClock(NOW);
    app = await buildApp({
      env: testEnv(),
      logger: createLogger(testEnv()),
      db,
      clock,
      googleVerifier: new FakeGoogleIdTokenVerifier(new Map()),
      mediaStorage: fakeMediaStorage,
      checkDb: async () => true,
    });
    await app.ready();
  });

  it('valid token: full check-in flow (scan -> photo -> check-in) ends inside, one gate event', async () => {
    const hostelId = await makeHostel(db);
    const hostId = await makeVerifiedHost(db, hostelId);
    const { code, secret } = await makeGateWithSecret(hostelId);
    const visitorId = await makeVisitor(db);
    const visit = await db
      .insertInto('haven.visits')
      .values({
        code: 'VGATE01',
        hostel_id: hostelId,
        host_id: hostId,
        visitor_id: visitorId,
        type: 'day',
        status: 'approved',
        origin: 'invite',
        zone: 'visitors_room',
        window_start: NOW.toISOString(),
        window_end: new Date(NOW.getTime() + 3 * 3_600_000).toISOString(),
        rules_version: 1,
        created_by_type: 'user',
        created_by_id: hostId,
      })
      .returning('id')
      .executeTakeFirstOrThrow();

    const token = generateGateToken({ secret, gateCode: code, now: clock.now() });
    const createRes = await supertest(app.server)
      .post('/v1/scan-sessions')
      .send({ token, clientNonce: 'nonce-valid-token', location: goodLocation() });
    expect(createRes.status).toBe(201);
    expect(createRes.body.gpsOk).toBe(true);
    const sessionId = createRes.body.scanSessionId;

    const accessToken = await issueToken(clock, { type: 'visitor', id: visitorId });
    const photoBuf = await tinyJpeg();
    const photoRes = await supertest(app.server)
      .post(`/v1/scan-sessions/${sessionId}/photo`)
      .set('Authorization', `Bearer ${accessToken}`)
      .set('X-Scan-Nonce', 'nonce-valid-token')
      .attach('photo', photoBuf, 'guest.jpg');
    expect(photoRes.status).toBe(200);
    const photoId = photoRes.body.photoId;
    expect(photoId).toBeTruthy();

    const checkInRes = await supertest(app.server)
      .post(`/v1/scan-sessions/${sessionId}/check-in`)
      .set('Idempotency-Key', randomUUID())
      .set('Authorization', `Bearer ${accessToken}`)
      .set('X-Scan-Nonce', 'nonce-valid-token')
      .send({ visitId: visit.id, photoId });
    expect(checkInRes.status).toBe(200);
    expect(checkInRes.body.result).toBe('inside');
    expect(checkInRes.body.visit.status).toBe('inside');

    const events = await db
      .selectFrom('haven.gate_events')
      .selectAll()
      .where('visit_id', '=', visit.id)
      .execute();
    expect(events).toHaveLength(1);
    expect(events.at(0)?.kind).toBe('entry');
    expect(events.at(0)?.scan_session_id).toBe(sessionId);

    const sessionRow = await db
      .selectFrom('haven.scan_sessions')
      .selectAll()
      .where('id', '=', sessionId)
      .executeTakeFirstOrThrow();
    expect(sessionRow.consumed_action).toBe('check_in');
    expect(sessionRow.consumed_at).not.toBeNull();
  });

  it('location failure on check-in: gpsOk false and no host confirmation yields awaiting_host_confirmation without completing entry', async () => {
    const hostelId = await makeHostel(db);
    const hostId = await makeVerifiedHost(db, hostelId);
    const { code, secret } = await makeGateWithSecret(hostelId);
    const visitorId = await makeVisitor(db);
    const visit = await db
      .insertInto('haven.visits')
      .values({
        code: 'VGATE03',
        hostel_id: hostelId,
        host_id: hostId,
        visitor_id: visitorId,
        type: 'day',
        status: 'approved',
        origin: 'invite',
        zone: 'visitors_room',
        window_start: NOW.toISOString(),
        window_end: new Date(NOW.getTime() + 3 * 3_600_000).toISOString(),
        rules_version: 1,
        created_by_type: 'user',
        created_by_id: hostId,
      })
      .returning('id')
      .executeTakeFirstOrThrow();

    const token = generateGateToken({ secret, gateCode: code, now: clock.now() });
    const createRes = await supertest(app.server)
      .post('/v1/scan-sessions')
      .send({
        token,
        clientNonce: 'host-confirm-nonce',
        location: { lat: GATE_LAT + 1, lng: GATE_LNG, accuracy: 10, fixAgeMs: 1000 },
      });
    expect(createRes.body.gpsOk).toBe(false);
    const sessionId = createRes.body.scanSessionId;
    const accessToken = await issueToken(clock, { type: 'visitor', id: visitorId });
    const photoBuf = await tinyJpeg();
    const photoRes = await supertest(app.server)
      .post(`/v1/scan-sessions/${sessionId}/photo`)
      .set('Authorization', `Bearer ${accessToken}`)
      .set('X-Scan-Nonce', 'host-confirm-nonce')
      .attach('photo', photoBuf, 'guest.jpg');
    const photoId = photoRes.body.photoId;

    const checkInRes = await supertest(app.server)
      .post(`/v1/scan-sessions/${sessionId}/check-in`)
      .set('Idempotency-Key', randomUUID())
      .set('Authorization', `Bearer ${accessToken}`)
      .set('X-Scan-Nonce', 'host-confirm-nonce')
      .send({ visitId: visit.id, photoId });
    expect(checkInRes.status).toBe(200);
    expect(checkInRes.body.result).toBe('awaiting_host_confirmation');
    expect(checkInRes.body.visit.status).toBe('approved');

    const visitRow = await db
      .selectFrom('haven.visits')
      .select('status')
      .where('id', '=', visit.id)
      .executeTakeFirstOrThrow();
    expect(visitRow.status).toBe('approved');

    const notif = await db
      .selectFrom('haven.notifications')
      .selectAll()
      .where('visit_id', '=', visit.id)
      .where('kind', '=', 'N-CONFIRM-LOCATION')
      .executeTakeFirst();
    expect(notif).toBeTruthy();

    const sessionRow = await db
      .selectFrom('haven.scan_sessions')
      .select('consumed_at')
      .where('id', '=', sessionId)
      .executeTakeFirstOrThrow();
    expect(sessionRow.consumed_at).toBeNull();
  });

  it('malformed token: unparsable string is GATE_TOKEN_INVALID', async () => {
    const res = await supertest(app.server)
      .post('/v1/scan-sessions')
      .send({ token: 'garbage', clientNonce: 'n1', location: goodLocation() });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('GATE_TOKEN_INVALID');
  });

  it('unknown gate: well-formed token for a gate code that does not exist', async () => {
    const fakeSecret = randomSecret(32);
    const token = generateGateToken({ secret: fakeSecret, gateCode: 'ZZZZZZ', now: clock.now() });
    const res = await supertest(app.server)
      .post('/v1/scan-sessions')
      .send({ token, clientNonce: 'n2', location: goodLocation() });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('GATE_TOKEN_INVALID');
  });

  it('inactive gate: GATE_TOKEN_INVALID even with the correct secret', async () => {
    const hostelId = await makeHostel(db);
    const { code, secret } = await makeGateWithSecret(hostelId);
    await db
      .updateTable('haven.gates')
      .set({ is_active: false })
      .where('code', '=', code)
      .execute();
    const token = generateGateToken({ secret, gateCode: code, now: clock.now() });
    const res = await supertest(app.server)
      .post('/v1/scan-sessions')
      .send({ token, clientNonce: 'n3', location: goodLocation() });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('GATE_TOKEN_INVALID');
  });

  it('expired token: 3 steps old is GATE_TOKEN_EXPIRED', async () => {
    const hostelId = await makeHostel(db);
    const { code, secret } = await makeGateWithSecret(hostelId);
    const staleTime = new Date(clock.now().getTime() - 3 * STEP_MS);
    const token = generateGateToken({ secret, gateCode: code, now: staleTime });
    const res = await supertest(app.server)
      .post('/v1/scan-sessions')
      .send({ token, clientNonce: 'n4', location: goodLocation() });
    expect(res.status).toBe(410);
    expect(res.body.error.code).toBe('GATE_TOKEN_EXPIRED');
  });

  it('future token: far ahead of the server clock is GATE_TOKEN_EXPIRED', async () => {
    const hostelId = await makeHostel(db);
    const { code, secret } = await makeGateWithSecret(hostelId);
    const futureTime = new Date(clock.now().getTime() + 10 * STEP_MS);
    const token = generateGateToken({ secret, gateCode: code, now: futureTime });
    const res = await supertest(app.server)
      .post('/v1/scan-sessions')
      .send({ token, clientNonce: 'n5', location: goodLocation() });
    expect(res.status).toBe(410);
    expect(res.body.error.code).toBe('GATE_TOKEN_EXPIRED');
  });

  it('wrong MAC: a token for the right gate but signed with a different secret is GATE_TOKEN_INVALID', async () => {
    const hostelId = await makeHostel(db);
    const { code } = await makeGateWithSecret(hostelId);
    const wrongSecret = randomSecret(32);
    const token = generateGateToken({ secret: wrongSecret, gateCode: code, now: clock.now() });
    const res = await supertest(app.server)
      .post('/v1/scan-sessions')
      .send({ token, clientNonce: 'n6', location: goodLocation() });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('GATE_TOKEN_INVALID');
  });

  it('rotated secret within the 120s grace window still verifies', async () => {
    const hostelId = await makeHostel(db);
    const { gateId, code, secret: oldSecret } = await makeGateWithSecret(hostelId);
    const newSecret = randomSecret(32);
    await db
      .updateTable('haven.gates')
      .set({
        secret_enc: encryptAesGcm(newSecret, DATA_ENCRYPTION_KEY),
        prev_secret_enc: encryptAesGcm(oldSecret, DATA_ENCRYPTION_KEY),
        secret_version: 2,
        secret_rotated_at: clock.now().toISOString(),
      })
      .where('id', '=', gateId)
      .execute();

    const token = generateGateToken({ secret: oldSecret, gateCode: code, now: clock.now() });
    const res = await supertest(app.server)
      .post('/v1/scan-sessions')
      .send({ token, clientNonce: 'n7', location: goodLocation() });
    expect(res.status).toBe(201);
  });

  it('previous secret grace window: after 120s, the old secret is rejected', async () => {
    const hostelId = await makeHostel(db);
    const { gateId, code, secret: oldSecret } = await makeGateWithSecret(hostelId);
    const newSecret = randomSecret(32);
    await db
      .updateTable('haven.gates')
      .set({
        secret_enc: encryptAesGcm(newSecret, DATA_ENCRYPTION_KEY),
        prev_secret_enc: encryptAesGcm(oldSecret, DATA_ENCRYPTION_KEY),
        secret_version: 2,
        secret_rotated_at: clock.now().toISOString(),
      })
      .where('id', '=', gateId)
      .execute();

    clock.advance(121_000);
    const token = generateGateToken({ secret: oldSecret, gateCode: code, now: clock.now() });
    const res = await supertest(app.server)
      .post('/v1/scan-sessions')
      .send({ token, clientNonce: 'n8', location: goodLocation() });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('GATE_TOKEN_INVALID');
  });

  it('location failure: outside the geofence, gpsOk is false with outside_geofence', async () => {
    const hostelId = await makeHostel(db);
    const { code, secret } = await makeGateWithSecret(hostelId);
    const token = generateGateToken({ secret, gateCode: code, now: clock.now() });
    const res = await supertest(app.server)
      .post('/v1/scan-sessions')
      .send({
        token,
        clientNonce: 'n9',
        location: { lat: GATE_LAT + 1, lng: GATE_LNG, accuracy: 10, fixAgeMs: 1000 },
      });
    expect(res.status).toBe(201);
    expect(res.body.gpsOk).toBe(false);
    expect(res.body.gpsFailure).toBe('outside_geofence');
  });

  it('location retry limit: a 4th attempt is LOCATION_RETRY_LIMIT', async () => {
    const hostelId = await makeHostel(db);
    const { code, secret } = await makeGateWithSecret(hostelId);
    const token = generateGateToken({ secret, gateCode: code, now: clock.now() });
    const badLocation = { lat: GATE_LAT + 1, lng: GATE_LNG, accuracy: 10, fixAgeMs: 1000 };
    const createRes = await supertest(app.server)
      .post('/v1/scan-sessions')
      .send({ token, clientNonce: 'n10', location: badLocation });
    const sessionId = createRes.body.scanSessionId;

    for (let i = 0; i < 2; i++) {
      const retry = await supertest(app.server)
        .post(`/v1/scan-sessions/${sessionId}/location`)
        .set('X-Scan-Nonce', 'n10')
        .send({ location: badLocation });
      expect(retry.status).toBe(200);
    }
    const fourth = await supertest(app.server)
      .post(`/v1/scan-sessions/${sessionId}/location`)
      .set('X-Scan-Nonce', 'n10')
      .send({ location: badLocation });
    expect(fourth.status).toBe(429);
    expect(fourth.body.error.code).toBe('LOCATION_RETRY_LIMIT');
  });

  it('location retry needs the session nonce (SDD §12.1; SECURITY-AUDIT SA-15)', async () => {
    const hostelId = await makeHostel(db);
    const { code, secret } = await makeGateWithSecret(hostelId);
    const token = generateGateToken({ secret, gateCode: code, now: clock.now() });
    const badLocation = { lat: GATE_LAT + 1, lng: GATE_LNG, accuracy: 10, fixAgeMs: 1000 };
    const created = await supertest(app.server)
      .post('/v1/scan-sessions')
      .send({ token, clientNonce: 'n11', location: badLocation });
    const url = `/v1/scan-sessions/${created.body.scanSessionId}/location`;
    const missing = await supertest(app.server).post(url).send({ location: badLocation });
    expect(missing.status).toBe(403);
    expect(missing.body.error.code).toBe('SCAN_SESSION_FORBIDDEN');
    const wrong = await supertest(app.server)
      .post(url)
      .set('X-Scan-Nonce', 'someone-else')
      .send({ location: badLocation });
    expect(wrong.status).toBe(403);
  });

  it('invalid scan session: a nonexistent session id is SCAN_SESSION_EXPIRED', async () => {
    const visitorId = await makeVisitor(db);
    const accessToken = await issueToken(clock, { type: 'visitor', id: visitorId });
    const res = await supertest(app.server)
      .post('/v1/scan-sessions/00000000-0000-0000-0000-000000000000/check-in')
      .set('Idempotency-Key', randomUUID())
      .set('Authorization', `Bearer ${accessToken}`)
      .set('X-Scan-Nonce', 'whatever')
      .send({
        visitId: '00000000-0000-0000-0000-000000000001',
        photoId: '00000000-0000-0000-0000-000000000002',
      });
    expect(res.status).toBe(410);
    expect(res.body.error.code).toBe('SCAN_SESSION_EXPIRED');
  });

  it('wrong nonce: a different X-Scan-Nonce than the one used to create the session is SCAN_SESSION_FORBIDDEN', async () => {
    const hostelId = await makeHostel(db);
    const { code, secret } = await makeGateWithSecret(hostelId);
    const token = generateGateToken({ secret, gateCode: code, now: clock.now() });
    const createRes = await supertest(app.server)
      .post('/v1/scan-sessions')
      .send({ token, clientNonce: 'the-real-nonce', location: goodLocation() });
    const sessionId = createRes.body.scanSessionId;
    const visitorId = await makeVisitor(db);
    const accessToken = await issueToken(clock, { type: 'visitor', id: visitorId });

    const res = await supertest(app.server)
      .get(`/v1/scan-sessions/${sessionId}`)
      .set('Authorization', `Bearer ${accessToken}`)
      .set('X-Scan-Nonce', 'a-completely-different-nonce');
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('SCAN_SESSION_FORBIDDEN');
  });

  it('wrong principal: a second visitor cannot use a session already bound to the first', async () => {
    const hostelId = await makeHostel(db);
    const { code, secret } = await makeGateWithSecret(hostelId);
    const token = generateGateToken({ secret, gateCode: code, now: clock.now() });
    const createRes = await supertest(app.server)
      .post('/v1/scan-sessions')
      .send({ token, clientNonce: 'shared-nonce', location: goodLocation() });
    const sessionId = createRes.body.scanSessionId;

    const visitorA = await makeVisitor(db);
    const visitorB = await makeVisitor(db);
    const tokenA = await issueToken(clock, { type: 'visitor', id: visitorA });
    const tokenB = await issueToken(clock, { type: 'visitor', id: visitorB });

    const first = await supertest(app.server)
      .get(`/v1/scan-sessions/${sessionId}`)
      .set('Authorization', `Bearer ${tokenA}`)
      .set('X-Scan-Nonce', 'shared-nonce');
    expect(first.status).toBe(200);

    const second = await supertest(app.server)
      .get(`/v1/scan-sessions/${sessionId}`)
      .set('Authorization', `Bearer ${tokenB}`)
      .set('X-Scan-Nonce', 'shared-nonce');
    expect(second.status).toBe(403);
    expect(second.body.error.code).toBe('SCAN_SESSION_FORBIDDEN');
  });

  it('already-consumed session: a second check-in call on the same session is SCAN_SESSION_EXPIRED', async () => {
    const hostelId = await makeHostel(db);
    const hostId = await makeVerifiedHost(db, hostelId);
    const { code, secret } = await makeGateWithSecret(hostelId);
    const visitorId = await makeVisitor(db);
    const visit = await db
      .insertInto('haven.visits')
      .values({
        code: 'VGATE02',
        hostel_id: hostelId,
        host_id: hostId,
        visitor_id: visitorId,
        type: 'day',
        status: 'approved',
        origin: 'invite',
        zone: 'visitors_room',
        window_start: NOW.toISOString(),
        window_end: new Date(NOW.getTime() + 3 * 3_600_000).toISOString(),
        rules_version: 1,
        created_by_type: 'user',
        created_by_id: hostId,
      })
      .returning('id')
      .executeTakeFirstOrThrow();

    const token = generateGateToken({ secret, gateCode: code, now: clock.now() });
    const createRes = await supertest(app.server)
      .post('/v1/scan-sessions')
      .send({ token, clientNonce: 'consume-once', location: goodLocation() });
    const sessionId = createRes.body.scanSessionId;
    const accessToken = await issueToken(clock, { type: 'visitor', id: visitorId });
    const photoBuf = await tinyJpeg();
    const photoRes = await supertest(app.server)
      .post(`/v1/scan-sessions/${sessionId}/photo`)
      .set('Authorization', `Bearer ${accessToken}`)
      .set('X-Scan-Nonce', 'consume-once')
      .attach('photo', photoBuf, 'guest.jpg');
    const photoId = photoRes.body.photoId;

    const first = await supertest(app.server)
      .post(`/v1/scan-sessions/${sessionId}/check-in`)
      .set('Idempotency-Key', randomUUID())
      .set('Authorization', `Bearer ${accessToken}`)
      .set('X-Scan-Nonce', 'consume-once')
      .send({ visitId: visit.id, photoId });
    expect(first.status).toBe(200);

    const second = await supertest(app.server)
      .post(`/v1/scan-sessions/${sessionId}/check-in`)
      .set('Idempotency-Key', randomUUID())
      .set('Authorization', `Bearer ${accessToken}`)
      .set('X-Scan-Nonce', 'consume-once')
      .send({ visitId: visit.id, photoId });
    expect(second.status).toBe(410);
    expect(second.body.error.code).toBe('SCAN_SESSION_EXPIRED');
  });

  it('walk-in via scan session creates a pending_host visit', async () => {
    const hostelId = await makeHostel(db);
    const hostId = await makeVerifiedHost(db, hostelId);
    const { code, secret } = await makeGateWithSecret(hostelId);
    const visitorId = await makeVisitor(db);

    const token = generateGateToken({ secret, gateCode: code, now: clock.now() });
    const createRes = await supertest(app.server)
      .post('/v1/scan-sessions')
      .send({ token, clientNonce: 'walkin-nonce', location: goodLocation() });
    const sessionId = createRes.body.scanSessionId;
    const accessToken = await issueToken(clock, { type: 'visitor', id: visitorId });
    const photoBuf = await tinyJpeg();
    const photoRes = await supertest(app.server)
      .post(`/v1/scan-sessions/${sessionId}/photo`)
      .set('Authorization', `Bearer ${accessToken}`)
      .set('X-Scan-Nonce', 'walkin-nonce')
      .attach('photo', photoBuf, 'guest.jpg');
    const photoId = photoRes.body.photoId;

    const res = await supertest(app.server)
      .post(`/v1/scan-sessions/${sessionId}/walk-in`)
      .set('Idempotency-Key', randomUUID())
      .set('Authorization', `Bearer ${accessToken}`)
      .set('X-Scan-Nonce', 'walkin-nonce')
      .send({ hostId, type: 'day', durationMinutes: 60, photoId });
    expect(res.status).toBe(201);
    expect(res.body.visit.status).toBe('pending_host');
  });

  it('host-assisted entry creates and checks in a visitor directly', async () => {
    const hostelId = await makeHostel(db);
    const hostId = await makeVerifiedHost(db, hostelId);
    const { code, secret } = await makeGateWithSecret(hostelId);

    const token = generateGateToken({ secret, gateCode: code, now: clock.now() });
    const createRes = await supertest(app.server)
      .post('/v1/scan-sessions')
      .send({ token, clientNonce: 'host-assist-nonce', location: goodLocation() });
    const sessionId = createRes.body.scanSessionId;
    const hostToken = await issueToken(clock, { type: 'user', id: hostId });
    const photoBuf = await tinyJpeg();
    const photoRes = await supertest(app.server)
      .post(`/v1/scan-sessions/${sessionId}/photo`)
      .set('Authorization', `Bearer ${hostToken}`)
      .set('X-Scan-Nonce', 'host-assist-nonce')
      .attach('photo', photoBuf, 'guest.jpg');
    const photoId = photoRes.body.photoId;

    const res = await supertest(app.server)
      .post(`/v1/scan-sessions/${sessionId}/host-assisted-entry`)
      .set('Authorization', `Bearer ${hostToken}`)
      .set('X-Scan-Nonce', 'host-assist-nonce')
      .set('Idempotency-Key', randomUUID())
      .send({
        guest: { name: 'Walk In Guest', gender: 'female' },
        type: 'day',
        durationMinutes: 60,
        photoId,
      });
    expect(res.status).toBe(201);
    expect(res.body.visit.status).toBe('inside');
  });
});

describe('POST /v1/me/profile-photo (SDD §9.4, G-05)', () => {
  let app: FastifyInstance;
  let clock: FakeClock;

  beforeEach(async () => {
    await resetAllHavenTables();
    __resetPolicyRegistryForTests();
    __resetVisitPoliciesForTests();
    __resetGatePoliciesForTests();
    __resetAuthPoliciesForTests();
    registerVisitPolicies();
    registerGatePolicies();
    clock = new FakeClock(NOW);
    app = await buildApp({
      env: testEnv(),
      logger: createLogger(testEnv()),
      db,
      clock,
      googleVerifier: new FakeGoogleIdTokenVerifier(new Map()),
      mediaStorage: fakeMediaStorage,
      checkDb: async () => true,
    });
    await app.ready();
  });

  it('stores the photo and sets visitors.profile_media_id', async () => {
    const visitorId = await makeVisitor(db);
    const accessToken = await issueToken(clock, { type: 'visitor', id: visitorId });
    const photoBuf = await tinyJpeg();

    const res = await supertest(app.server)
      .post('/v1/me/profile-photo')
      .set('Authorization', `Bearer ${accessToken}`)
      .attach('photo', photoBuf, 'selfie.jpg');

    expect(res.status).toBe(200);
    expect(res.body.photoId).toBeTruthy();

    const visitorRow = await db
      .selectFrom('haven.visitors')
      .select('profile_media_id')
      .where('id', '=', visitorId)
      .executeTakeFirstOrThrow();
    expect(visitorRow.profile_media_id).toBe(res.body.photoId);

    const mediaRow = await db
      .selectFrom('haven.media')
      .select(['kind', 'bucket', 'owner_visitor_id'])
      .where('id', '=', res.body.photoId)
      .executeTakeFirstOrThrow();
    expect(mediaRow.kind).toBe('visitor_profile');
    expect(mediaRow.bucket).toBe('visitor-photos');
    expect(mediaRow.owner_visitor_id).toBe(visitorId);
  });

  it('rejects an unauthenticated request', async () => {
    const photoBuf = await tinyJpeg();
    const res = await supertest(app.server)
      .post('/v1/me/profile-photo')
      .attach('photo', photoBuf, 'selfie.jpg');
    expect(res.status).toBe(401);
  });
});

describe('gate device pairing and heartbeat (SDD F8)', () => {
  let app: FastifyInstance;
  let clock: FakeClock;

  beforeEach(async () => {
    await resetAllHavenTables();
    __resetPolicyRegistryForTests();
    __resetVisitPoliciesForTests();
    __resetGatePoliciesForTests();
    __resetAuthPoliciesForTests();
    registerVisitPolicies();
    registerGatePolicies();
    clock = new FakeClock(NOW);
    app = await buildApp({
      env: testEnv(),
      logger: createLogger(testEnv()),
      db,
      clock,
      googleVerifier: new FakeGoogleIdTokenVerifier(new Map()),
      mediaStorage: fakeMediaStorage,
      checkDb: async () => true,
    });
    await app.ready();
  });

  it('pairs a device, heartbeats, and rotates the secret on revoke', async () => {
    const hostelId = await makeHostel(db);
    const wardenId = await makeVerifiedHost(db, hostelId); // stand-in "warden" id for pairing-code creator FK
    const { gateId } = await makeGateWithSecret(hostelId);

    const { createPairingCode } = await import('../src/gate/devices.js');
    const pairing = await createPairingCode({ db, clock, gateId, createdByUserId: wardenId });

    const pairRes = await supertest(app.server)
      .post('/v1/gate-devices/pair')
      .send({ code: pairing.code });
    expect(pairRes.status).toBe(200);
    expect(pairRes.body.deviceToken).toMatch(/^gd_/);
    const deviceToken = pairRes.body.deviceToken;

    const heartbeatRes = await supertest(app.server)
      .post('/v1/gate-devices/heartbeat')
      .set('Authorization', `Device ${deviceToken}`)
      .send({ clientTime: clock.now().toISOString() });
    expect(heartbeatRes.status).toBe(200);
    expect(heartbeatRes.body.revoked).toBe(false);
    expect(heartbeatRes.body.secretVersion).toBe(1);

    const device = await db
      .selectFrom('haven.gate_devices')
      .select('id')
      .where('gate_id', '=', gateId)
      .executeTakeFirstOrThrow();
    const { revokeDevice } = await import('../src/gate/devices.js');
    await revokeDevice({
      db,
      clock,
      dataEncryptionKey: DATA_ENCRYPTION_KEY,
      deviceId: device.id,
      revokedByUserId: wardenId,
    });

    const afterRevoke = await supertest(app.server)
      .post('/v1/gate-devices/heartbeat')
      .set('Authorization', `Device ${deviceToken}`)
      .send({ clientTime: clock.now().toISOString() });
    expect(afterRevoke.status).toBe(200);
    expect(afterRevoke.body.revoked).toBe(true);

    const gateRow = await db
      .selectFrom('haven.gates')
      .select(['secret_version'])
      .where('id', '=', gateId)
      .executeTakeFirstOrThrow();
    expect(gateRow.secret_version).toBe(2);
  });
});
