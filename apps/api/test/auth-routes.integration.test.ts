import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { __resetEnvCacheForTests, loadEnv } from '../src/config.js';
import { getTestDb, resetAllHavenTables } from './db-test-helper.js';
import { FakeClock } from '../src/lib/clock.js';
import { FakeGoogleIdTokenVerifier } from '../src/auth/google.js';
import { sha256 } from '../src/lib/crypto.js';
import type { MediaStorage } from '../src/gate/media.js';
import { TEST_DATABASE_URL } from './pg-test-constants.js';
import { __resetPolicyRegistryForTests } from '../src/auth/policy.js';
import { __resetAuthPoliciesForTests } from '../src/auth/policy-rules.js';

const JWT_SECRET = Buffer.alloc(32, 1).toString('base64');
const OTP_PEPPER = Buffer.alloc(32, 2).toString('base64');
const DATA_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString('base64');
const fakeMediaStorage: MediaStorage = {
  put: async () => undefined,
  get: async () => null,
  delete: async () => undefined,
};

function testEnv() {
  __resetEnvCacheForTests();
  return loadEnv({
    DATABASE_URL: TEST_DATABASE_URL,
    DATABASE_DIRECT_URL: TEST_DATABASE_URL,
    JWT_SECRET,
    OTP_PEPPER,
    GOOGLE_CLIENT_IDS: 'test-client-id',
    DATA_ENCRYPTION_KEY,
    LOG_LEVEL: 'silent',
  });
}

const db = getTestDb();

async function readPrintedOtp(phone: string, run: () => Promise<void>): Promise<string> {
  const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  await run();
  const printed = logSpy.mock.calls
    .map((args) => String(args[0]))
    .find((line) => line.includes(phone));
  logSpy.mockRestore();
  const match = printed?.match(/purpose-code=(\d{6})/);
  if (!match) throw new Error('expected a printed dev OTP code');
  return match[1];
}

describe('auth routes (SDD §9.5, §12.4) end to end', () => {
  let app: FastifyInstance;
  let clock: FakeClock;
  let googleVerifier: FakeGoogleIdTokenVerifier;

  beforeEach(async () => {
    await resetAllHavenTables();
    // Defensive, order-independent reset: other integration-test files in this same
    // worker process (vitest's isolate:false) may have cleared the shared policy
    // registry without re-registering auth's own rules — `buildApp` below re-adds
    // them via `registerAuthRoutes` -> `registerAuthPolicies()`, but only if that
    // module's own idempotency flag has been reset first.
    __resetPolicyRegistryForTests();
    __resetAuthPoliciesForTests();
    clock = new FakeClock(new Date('2026-10-01T10:00:00Z'));
    googleVerifier = new FakeGoogleIdTokenVerifier(new Map());
    app = await buildApp({
      env: testEnv(),
      logger: (await import('../src/lib/logger.js')).createLogger(testEnv()),
      db,
      clock,
      googleVerifier,
      mediaStorage: fakeMediaStorage,
      checkDb: async () => true,
    });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it('valid authentication: guest OTP login issues an access token and a cookie-set refresh token', async () => {
    const phone = '9876500001';
    const code = await readPrintedOtp('+919876500001', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/auth/otp/request',
        payload: { phone, purpose: 'guest_login' },
      });
      expect(res.statusCode).toBe(202);
      expect(res.json()).toMatchObject({ resendAfterS: 30 });
    });

    const verifyRes = await app.inject({
      method: 'POST',
      url: '/v1/auth/otp/verify',
      payload: { phone, code, purpose: 'guest_login' },
    });
    expect(verifyRes.statusCode).toBe(200);
    const body = verifyRes.json();
    expect(body.accessToken).toBeDefined();
    expect(body.principal.profileComplete).toBe(false);
    expect(verifyRes.cookies.some((c: { name: string }) => c.name === 'haven_rt')).toBe(true);

    const meRes = await app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: { authorization: `Bearer ${body.accessToken}` },
    });
    expect(meRes.statusCode).toBe(200);
    expect(meRes.json()).toMatchObject({ type: 'visitor', phone: '+919876500001' });
  });

  it('invalid credentials: the wrong OTP code is rejected with OTP_INVALID', async () => {
    const phone = '9876500002';
    await readPrintedOtp('+919876500002', async () => {
      await app.inject({
        method: 'POST',
        url: '/v1/auth/otp/request',
        payload: { phone, purpose: 'guest_login' },
      });
    });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/otp/verify',
      payload: { phone, code: '000000', purpose: 'guest_login' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('OTP_INVALID');
  });

  it('expired credentials: a missing/garbage access token is AUTH_REQUIRED', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: { authorization: 'Bearer not-a-real-jwt' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('AUTH_REQUIRED');
  });

  it('revoked sessions: after logout, the old access token is rejected with SESSION_REVOKED', async () => {
    const phone = '9876500003';
    const code = await readPrintedOtp('+919876500003', async () => {
      await app.inject({
        method: 'POST',
        url: '/v1/auth/otp/request',
        payload: { phone, purpose: 'guest_login' },
      });
    });
    const verifyRes = await app.inject({
      method: 'POST',
      url: '/v1/auth/otp/verify',
      payload: { phone, code, purpose: 'guest_login' },
    });
    const { accessToken } = verifyRes.json();

    const logoutRes = await app.inject({
      method: 'POST',
      url: '/v1/auth/logout',
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(logoutRes.statusCode).toBe(204);

    // The revocation cache is 30s-TTL — advance the clock so it re-checks the DB.
    clock.advance(31_000);
    const meRes = await app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(meRes.statusCode).toBe(401);
    expect(meRes.json().error.code).toBe('SESSION_REVOKED');
  });

  it('deactivated users: a deactivated user is rejected within the 30s cache window', async () => {
    const sub = 'google-sub-deactivate';
    googleVerifier = new FakeGoogleIdTokenVerifier(
      new Map([
        [`tok-${sub}`, { sub, email: 'deact@haven.test', emailVerified: true, name: 'Deact User' }],
      ]),
    );
    await app.close();
    app = await buildApp({
      env: testEnv(),
      logger: (await import('../src/lib/logger.js')).createLogger(testEnv()),
      db,
      clock,
      googleVerifier,
      mediaStorage: fakeMediaStorage,
      checkDb: async () => true,
    });
    await app.ready();

    const signInRes = await app.inject({
      method: 'POST',
      url: '/v1/auth/google',
      payload: { idToken: `tok-${sub}` },
    });
    expect(signInRes.statusCode).toBe(200);
    const { accessToken, principal } = signInRes.json();

    await db
      .updateTable('haven.users')
      .set({ is_active: false })
      .where('id', '=', principal.id)
      .execute();
    clock.advance(31_000);

    const meRes = await app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(meRes.statusCode).toBe(401);
    expect(meRes.json().error.code).toBe('SESSION_REVOKED');
  });

  it('authorization boundaries / cross-user access attempts: authorize() denies a mismatched resource', async () => {
    const { authorize } = await import('../src/auth/policy.js');
    const { registerAuthPolicies } = await import('../src/auth/policy-rules.js');
    registerAuthPolicies();
    const principal = { type: 'user' as const, userId: 'user-a', sessionId: 's1', roles: [] };
    expect(() =>
      authorize(principal, 'me.read', { ownerType: 'user', ownerId: 'user-a' }),
    ).not.toThrow();
    expect(() =>
      authorize(principal, 'me.read', { ownerType: 'user', ownerId: 'user-b' }),
    ).toThrow();
  });

  it('OTP expiry: a code presented after 5 minutes is OTP_EXPIRED', async () => {
    const phone = '9876500004';
    const code = await readPrintedOtp('+919876500004', async () => {
      await app.inject({
        method: 'POST',
        url: '/v1/auth/otp/request',
        payload: { phone, purpose: 'guest_login' },
      });
    });
    clock.advance(5 * 60 * 1000 + 1000);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/otp/verify',
      payload: { phone, code, purpose: 'guest_login' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('OTP_EXPIRED');
  });

  it('refresh rotation via the route issues a new access token and rotates the cookie', async () => {
    const phone = '9876500005';
    const code = await readPrintedOtp('+919876500005', async () => {
      await app.inject({
        method: 'POST',
        url: '/v1/auth/otp/request',
        payload: { phone, purpose: 'guest_login' },
      });
    });
    const verifyRes = await app.inject({
      method: 'POST',
      url: '/v1/auth/otp/verify',
      payload: { phone, code, purpose: 'guest_login' },
    });
    const rtCookie = verifyRes.cookies.find((c: { name: string }) => c.name === 'haven_rt');
    if (!rtCookie) throw new Error('expected a haven_rt cookie on the verify response');

    const refreshRes = await app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      cookies: { haven_rt: rtCookie.value },
      payload: {},
    });
    expect(refreshRes.statusCode).toBe(200);
    expect(refreshRes.json().accessToken).toBeDefined();
  });

  it('wrong invited phone via the route: INVITE_PHONE_MISMATCH', async () => {
    const hostel = await db
      .insertInto('haven.hostels')
      .values({ code: 'RHOST1', name: 'Route Hostel', gender_served: 'male' })
      .returning('id')
      .executeTakeFirstOrThrow();
    const hostUser = await db
      .insertInto('haven.users')
      .values({
        google_sub: 'route-host-sub',
        email: 'route-host@haven.test',
        full_name: 'Route Host',
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    const room = await db
      .insertInto('haven.rooms')
      .values({ hostel_id: hostel.id, number: 'B1' })
      .returning('id')
      .executeTakeFirstOrThrow();
    await db
      .insertInto('haven.residents')
      .values({
        user_id: hostUser.id,
        hostel_id: hostel.id,
        claimed_room: 'B1',
        room_id: room.id,
        status: 'verified',
      })
      .execute();
    await db
      .insertInto('haven.visits')
      .values({
        code: 'V2345A6',
        hostel_id: hostel.id,
        host_id: hostUser.id,
        invited_name: 'Invited Guest',
        invited_phone: '+919876577777',
        type: 'day',
        status: 'pending_host',
        origin: 'invite',
        zone: 'room',
        window_start: new Date(clock.now().getTime() - 1000),
        window_end: new Date(clock.now().getTime() + 60 * 60 * 1000),
        invite_token_hash: sha256('route-claim-token'),
        rules_version: 1,
        created_by_type: 'user',
        created_by_id: hostUser.id,
      })
      .execute();

    const phone = '9876588888';
    const code = await readPrintedOtp('+919876588888', async () => {
      await app.inject({
        method: 'POST',
        url: '/v1/auth/otp/request',
        payload: { phone, purpose: 'guest_login' },
      });
    });
    const verifyRes = await app.inject({
      method: 'POST',
      url: '/v1/auth/otp/verify',
      payload: { phone, code, purpose: 'guest_login' },
    });
    const { accessToken } = verifyRes.json();

    const claimRes = await app.inject({
      method: 'POST',
      url: '/v1/invites/route-claim-token/claim',
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(claimRes.statusCode).toBe(403);
    expect(claimRes.json().error.code).toBe('INVITE_PHONE_MISMATCH');
  });
});
