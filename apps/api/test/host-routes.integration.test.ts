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
import { generateGateToken } from '../src/gate/token.js';
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

function testEnv(overrides: Record<string, string> = {}) {
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
    ...overrides,
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

async function buildTestApp(clock: FakeClock, envOverrides: Record<string, string> = {}) {
  __resetPolicyRegistryForTests();
  __resetVisitPoliciesForTests();
  __resetGatePoliciesForTests();
  __resetAuthPoliciesForTests();
  registerVisitPolicies();
  registerGatePolicies();
  const app = await buildApp({
    env: testEnv(envOverrides),
    logger: createLogger(testEnv(envOverrides)),
    db,
    clock,
    googleVerifier: new FakeGoogleIdTokenVerifier(new Map()),
    mediaStorage: fakeMediaStorage,
    checkDb: async () => true,
  });
  await app.ready();
  return app;
}

describe('host visits routes (SDD §12.6) end to end', () => {
  let app: FastifyInstance;
  let clock: FakeClock;

  beforeEach(async () => {
    await resetAllHavenTables();
    clock = new FakeClock(NOW);
    app = await buildTestApp(clock);
  });

  it('a verified resident creates a pre-invite and gets a shareable invite link', async () => {
    const hostelId = await makeHostel(db);
    const hostId = await makeVerifiedHost(db, hostelId);
    const hostToken = await issueToken(clock, { type: 'user', id: hostId });

    const res = await supertest(app.server)
      .post('/v1/visits')
      .set('Authorization', `Bearer ${hostToken}`)
      .send({
        kind: 'invite',
        guest: { name: 'Simran Kaur', phone: '+919812345678', gender: 'female' },
        type: 'day',
        windowStart: NOW.toISOString(),
        windowEnd: new Date(NOW.getTime() + 3 * 3_600_000).toISOString(),
      });

    expect(res.status).toBe(201);
    expect(res.body.visit.status).toBe('approved');
    expect(res.body.inviteUrl).toMatch(/\/i\/[A-Za-z0-9_-]{20,}$/);
  });

  it('rejects an unverified resident', async () => {
    const user = await db
      .insertInto('haven.users')
      .values({ google_sub: 'unverified', email: 'u@haven.test', full_name: 'Unverified' })
      .returning('id')
      .executeTakeFirstOrThrow();
    const token = await issueToken(clock, { type: 'user', id: user.id });

    const res = await supertest(app.server)
      .post('/v1/visits')
      .set('Authorization', `Bearer ${token}`)
      .send({
        kind: 'invite',
        guest: { name: 'Simran Kaur', phone: '+919812345678' },
        type: 'day',
        windowStart: NOW.toISOString(),
        windowEnd: new Date(NOW.getTime() + 3_600_000).toISOString(),
      });
    expect(res.status).toBe(403);
  });

  it('GET /me/hosted-visits lists the host’s own visits', async () => {
    const hostelId = await makeHostel(db);
    const hostId = await makeVerifiedHost(db, hostelId);
    const hostToken = await issueToken(clock, { type: 'user', id: hostId });

    const createRes = await supertest(app.server)
      .post('/v1/visits')
      .set('Authorization', `Bearer ${hostToken}`)
      .send({
        kind: 'invite',
        guest: { name: 'Simran Kaur', phone: '+919812345678' },
        type: 'day',
        windowStart: NOW.toISOString(),
        windowEnd: new Date(NOW.getTime() + 3_600_000).toISOString(),
      });
    expect(createRes.status).toBe(201);

    const res = await supertest(app.server)
      .get('/v1/me/hosted-visits')
      .set('Authorization', `Bearer ${hostToken}`);
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.nextCursor).toBeNull();
  });

  it('approving a walk-in reuses the original scan session’s GPS facts and checks the guest in', async () => {
    const hostelId = await makeHostel(db);
    const hostId = await makeVerifiedHost(db, hostelId);
    const { code, secret } = await makeGateWithSecret(hostelId);
    const visitorId = await makeVisitor(db);

    const token = generateGateToken({ secret, gateCode: code, now: clock.now() });
    const createRes = await supertest(app.server)
      .post('/v1/scan-sessions')
      .send({ token, clientNonce: 'approve-nonce', location: goodLocation() });
    const sessionId = createRes.body.scanSessionId;
    const visitorToken = await issueToken(clock, { type: 'visitor', id: visitorId });
    const photoBuf = await tinyJpeg();
    const photoRes = await supertest(app.server)
      .post(`/v1/scan-sessions/${sessionId}/photo`)
      .set('Authorization', `Bearer ${visitorToken}`)
      .set('X-Scan-Nonce', 'approve-nonce')
      .attach('photo', photoBuf, 'guest.jpg');
    const photoId = photoRes.body.photoId;

    const walkInRes = await supertest(app.server)
      .post(`/v1/scan-sessions/${sessionId}/walk-in`)
      .set('Authorization', `Bearer ${visitorToken}`)
      .set('X-Scan-Nonce', 'approve-nonce')
      .send({ hostId, type: 'day', durationMinutes: 60, photoId });
    expect(walkInRes.status).toBe(201);
    const visitId = walkInRes.body.visit.id;

    const sessionRow = await db
      .selectFrom('haven.scan_sessions')
      .select(['visit_id', 'consumed_action'])
      .where('id', '=', sessionId)
      .executeTakeFirstOrThrow();
    expect(sessionRow.visit_id).toBe(visitId);
    expect(sessionRow.consumed_action).toBe('walk_in');

    const hostToken = await issueToken(clock, { type: 'user', id: hostId });
    const approveRes = await supertest(app.server)
      .post(`/v1/visits/${visitId}/approve`)
      .set('Idempotency-Key', randomUUID())
      .set('Authorization', `Bearer ${hostToken}`)
      .send({});
    expect(approveRes.status).toBe(200);
    expect(approveRes.body.status).toBe('inside');

    const events = await db
      .selectFrom('haven.gate_events')
      .selectAll()
      .where('visit_id', '=', visitId)
      .execute();
    expect(events).toHaveLength(1);
    expect(events.at(0)?.location_verified).toBe(true);
  });

  it('rejecting a walk-in notifies the guest and sets status rejected', async () => {
    const hostelId = await makeHostel(db);
    const hostId = await makeVerifiedHost(db, hostelId);
    const { code, secret } = await makeGateWithSecret(hostelId);
    const visitorId = await makeVisitor(db);

    const token = generateGateToken({ secret, gateCode: code, now: clock.now() });
    const createRes = await supertest(app.server)
      .post('/v1/scan-sessions')
      .send({ token, clientNonce: 'reject-nonce', location: goodLocation() });
    const sessionId = createRes.body.scanSessionId;
    const visitorToken = await issueToken(clock, { type: 'visitor', id: visitorId });
    const photoBuf = await tinyJpeg();
    const photoRes = await supertest(app.server)
      .post(`/v1/scan-sessions/${sessionId}/photo`)
      .set('Authorization', `Bearer ${visitorToken}`)
      .set('X-Scan-Nonce', 'reject-nonce')
      .attach('photo', photoBuf, 'guest.jpg');
    const photoId = photoRes.body.photoId;

    const walkInRes = await supertest(app.server)
      .post(`/v1/scan-sessions/${sessionId}/walk-in`)
      .set('Authorization', `Bearer ${visitorToken}`)
      .set('X-Scan-Nonce', 'reject-nonce')
      .send({ hostId, type: 'day', durationMinutes: 60, photoId });
    const visitId = walkInRes.body.visit.id;

    const hostToken = await issueToken(clock, { type: 'user', id: hostId });
    const rejectRes = await supertest(app.server)
      .post(`/v1/visits/${visitId}/reject`)
      .set('Idempotency-Key', randomUUID())
      .set('Authorization', `Bearer ${hostToken}`)
      .send({});
    expect(rejectRes.status).toBe(200);
    expect(rejectRes.body.status).toBe('rejected');

    const notif = await db
      .selectFrom('haven.notifications')
      .selectAll()
      .where('visit_id', '=', visitId)
      .where('kind', '=', 'N-WALKIN-REJECTED')
      .executeTakeFirst();
    expect(notif).toBeTruthy();
  });

  it('the guest cancels their own pending walk-in', async () => {
    const hostelId = await makeHostel(db);
    const hostId = await makeVerifiedHost(db, hostelId);
    const { code, secret } = await makeGateWithSecret(hostelId);
    const visitorId = await makeVisitor(db);

    const token = generateGateToken({ secret, gateCode: code, now: clock.now() });
    const createRes = await supertest(app.server)
      .post('/v1/scan-sessions')
      .send({ token, clientNonce: 'cancel-nonce', location: goodLocation() });
    const sessionId = createRes.body.scanSessionId;
    const visitorToken = await issueToken(clock, { type: 'visitor', id: visitorId });
    const photoBuf = await tinyJpeg();
    const photoRes = await supertest(app.server)
      .post(`/v1/scan-sessions/${sessionId}/photo`)
      .set('Authorization', `Bearer ${visitorToken}`)
      .set('X-Scan-Nonce', 'cancel-nonce')
      .attach('photo', photoBuf, 'guest.jpg');
    const photoId = photoRes.body.photoId;

    const walkInRes = await supertest(app.server)
      .post(`/v1/scan-sessions/${sessionId}/walk-in`)
      .set('Authorization', `Bearer ${visitorToken}`)
      .set('X-Scan-Nonce', 'cancel-nonce')
      .send({ hostId, type: 'day', durationMinutes: 60, photoId });
    const visitId = walkInRes.body.visit.id;

    const cancelRes = await supertest(app.server)
      .post(`/v1/me/visits/${visitId}/cancel`)
      .set('Authorization', `Bearer ${visitorToken}`);
    expect(cancelRes.status).toBe(200);
    expect(cancelRes.body.status).toBe('cancelled');
  });
});

describe('dev-login (DEC-011)', () => {
  const originalNodeEnv = process.env.NODE_ENV;

  async function withDevelopmentNodeEnv<T>(fn: () => Promise<T>): Promise<T> {
    process.env.NODE_ENV = 'development';
    try {
      return await fn();
    } finally {
      process.env.NODE_ENV = originalNodeEnv;
    }
  }

  it('signs in an existing user by email when enabled', async () => {
    await withDevelopmentNodeEnv(async () => {
      const clock = new FakeClock(NOW);
      await resetAllHavenTables();
      const hostelId = await makeHostel(db);
      const hostId = await makeVerifiedHost(db, hostelId);
      const userRow = await db
        .selectFrom('haven.users')
        .select('email')
        .where('id', '=', hostId)
        .executeTakeFirstOrThrow();

      const app = await buildTestApp(clock, { DEV_LOGIN_ENABLED: 'true' });
      const res = await supertest(app.server)
        .post('/v1/auth/dev-login')
        .send({ email: userRow.email });
      expect(res.status).toBe(200);
      expect(res.body.accessToken).toBeTruthy();
      expect(res.body.principal.id).toBe(hostId);
    });
  });

  it('404s for an email with no account', async () => {
    await withDevelopmentNodeEnv(async () => {
      const clock = new FakeClock(NOW);
      await resetAllHavenTables();
      const app = await buildTestApp(clock, { DEV_LOGIN_ENABLED: 'true' });
      const res = await supertest(app.server)
        .post('/v1/auth/dev-login')
        .send({ email: 'nobody@haven.test' });
      expect(res.status).toBe(404);
    });
  });

  it('is not registered at all when DEV_LOGIN_ENABLED is false', async () => {
    const clock = new FakeClock(NOW);
    await resetAllHavenTables();
    const app = await buildTestApp(clock, { DEV_LOGIN_ENABLED: 'false' });
    const res = await supertest(app.server)
      .post('/v1/auth/dev-login')
      .send({ email: 'anyone@haven.test' });
    expect(res.status).toBe(404);
  });

  it('refuses to boot with DEV_LOGIN_ENABLED=true outside NODE_ENV=development', async () => {
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const clock = new FakeClock(NOW);
      await resetAllHavenTables();
      await expect(buildTestApp(clock, { DEV_LOGIN_ENABLED: 'true' })).rejects.toThrow(
        /NODE_ENV=development/,
      );
    } finally {
      process.env.NODE_ENV = previous;
    }
  });
});
