import { PassThrough } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { SignJWT } from 'jose';
import supertest from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeClock } from '../src/lib/clock.js';
import { buildApp } from '../src/app.js';
import { createLogger } from '../src/lib/logger.js';
import { requestOtp, verifyOtp } from '../src/auth/otp-service.js';
import { hashOtpCode } from '../src/auth/otp.js';
import { DevBypassBotVerifier, type BotVerifier } from '../src/auth/bot-check.js';
import {
  createErrorReporter,
  NOOP_REPORTER,
  type ErrorReporter,
} from '../src/lib/error-reporter.js';
import { NotificationWorker } from '../src/notify/worker.js';
import { FakePushSender, FakeSmsSender } from './app-test-helpers.js';
import { resetAllHavenTables } from './db-test-helper.js';
import {
  buildTestApp,
  db,
  issueToken,
  JWT_SECRET,
  MemoryMediaStorage,
  scanAndPhoto,
  testEnv,
} from './app-test-helpers.js';
import { hostelWorld, pendingResident, type HostelWorld } from './staff-fixtures.js';
import { makeVisitor } from './visits-fixtures.js';

/**
 * Regression tests for docs/SECURITY-AUDIT.md. Each test names its finding and fails
 * on the code as it was before the fix.
 */

const NOW = new Date('2026-10-18T06:30:00.000Z'); // 12:00 IST
let clock: FakeClock;

beforeEach(async () => {
  await resetAllHavenTables();
  clock = new FakeClock(NOW);
});

/** Records every captcha check; answers with `pass`. */
class FakeBot implements BotVerifier {
  calls: (string | undefined)[] = [];
  constructor(public pass: boolean) {}
  async verify(token: string | undefined) {
    this.calls.push(token);
    return this.pass && token === 'good-token';
  }
}

describe('SA-01: room search needs the caller’s own live scan session (SDD §12.7)', () => {
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
    clock.set(NOW);
    w = await hostelWorld();
  });
  const room = async () =>
    (
      await db
        .selectFrom('haven.residents')
        .select('claimed_room')
        .where('user_id', '=', w.residentId)
        .executeTakeFirstOrThrow()
    ).claimed_room;

  it('the old public endpoint is gone', async () => {
    const res = await supertest(app.server).get(
      `/v1/rooms/search?hostelId=${w.hostelId}&number=${await room()}`,
    );
    expect(res.status).toBe(404);
  });

  it('refuses no auth, no session, someone else’s session and another hostel; returns display names only', async () => {
    const url = `/v1/hostels/${w.hostelId}/rooms/${await room()}/residents`;
    expect((await supertest(app.server).get(url)).status).toBe(401);

    const bearer = await issueToken(clock, { type: 'visitor', id: w.visitorId });
    const mine = await scanAndPhoto(app, clock, { gate: w.gate, bearer });
    const noSession = await supertest(app.server).get(url).set('Authorization', `Bearer ${bearer}`);
    expect(noSession.status).toBe(403);
    expect(noSession.body.error.code).toBe('SCAN_SESSION_FORBIDDEN');

    const other = await makeVisitor(db);
    const otherBearer = await issueToken(clock, { type: 'visitor', id: other });
    const stolen = await supertest(app.server)
      .get(url)
      .set('Authorization', `Bearer ${otherBearer}`)
      .set('X-Scan-Session', mine.sessionId)
      .set('X-Scan-Nonce', mine.nonce);
    expect(stolen.status).toBe(403);

    const elsewhere = await hostelWorld();
    const wrongHostel = await supertest(app.server)
      .get(`/v1/hostels/${elsewhere.hostelId}/rooms/${await room()}/residents`)
      .set('Authorization', `Bearer ${bearer}`)
      .set('X-Scan-Session', mine.sessionId)
      .set('X-Scan-Nonce', mine.nonce);
    expect(wrongHostel.status).toBe(403);
    expect(wrongHostel.body.error.code).toBe('FORBIDDEN');

    const ok = await supertest(app.server)
      .get(url)
      .set('Authorization', `Bearer ${bearer}`)
      .set('X-Scan-Session', mine.sessionId)
      .set('X-Scan-Nonce', mine.nonce);
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual([{ residentId: w.residentId, displayName: 'Test H.' }]);
  });

  it('is rate-limited to 10 per minute', async () => {
    // A fresh app: the limiter's budget is per app instance and client IP.
    const own = await buildTestApp(clock);
    const bearer = await issueToken(clock, { type: 'visitor', id: w.visitorId });
    const s = await scanAndPhoto(own, clock, { gate: w.gate, bearer });
    const url = `/v1/hostels/${w.hostelId}/rooms/${await room()}/residents`;
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) {
      const r = await supertest(own.server)
        .get(url)
        .set('Authorization', `Bearer ${bearer}`)
        .set('X-Scan-Session', s.sessionId)
        .set('X-Scan-Nonce', s.nonce);
      statuses.push(r.status);
    }
    await own.close();
    expect(statuses.slice(0, 10)).toEqual(Array(10).fill(200));
    expect(statuses[10]).toBe(429);
  });
});

describe('SA-02 / SA-24 / SA-30: auth bypasses can’t be switched on by accident', () => {
  const originalNodeEnv = process.env.NODE_ENV;
  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
  });

  it('the dev sign-in refuses to boot unless NODE_ENV=development', async () => {
    for (const nodeEnv of ['production', 'staging', 'test', '']) {
      process.env.NODE_ENV = nodeEnv;
      const env = testEnv({ DEV_LOGIN_ENABLED: 'true' });
      await expect(
        buildApp({
          env,
          logger: createLogger(env),
          db,
          clock,
          mediaStorage: new MemoryMediaStorage(),
          checkDb: async () => true,
        }),
      ).rejects.toThrow(/requires NODE_ENV=development/);
    }
  });

  it('without the flag the dev sign-in route doesn’t exist, even in development', async () => {
    process.env.NODE_ENV = 'development';
    const app = await buildTestApp(clock);
    const res = await supertest(app.server).post('/v1/auth/dev-login').send({ email: 'a@b.test' });
    expect(res.status).toBe(404);
    await app.close();
  });

  it('the 123456 test code never works with APP_ENV=production', async () => {
    const env = testEnv({ APP_ENV: 'production' });
    await expect(
      verifyOtp(db, { phone: '+919999900001', code: '123456', purpose: 'guest_login' }, env, clock),
    ).rejects.toMatchObject({ code: 'OTP_INVALID' });
  });
});

describe('SA-04: five wrong guesses per code, even in parallel', () => {
  it('20 parallel wrong guesses consume at most 5 attempts', async () => {
    const env = testEnv();
    const phone = '+919876500321';
    await db
      .insertInto('haven.otp_challenges')
      .values({
        phone,
        purpose: 'guest_login',
        code_hash: hashOtpCode(env.OTP_PEPPER, phone, '111111'),
        expires_at: new Date(NOW.getTime() + 300_000).toISOString(),
        created_at: NOW.toISOString(),
      })
      .execute();
    const results = await Promise.allSettled(
      Array.from({ length: 20 }, (_, i) =>
        verifyOtp(db, { phone, code: String(200000 + i), purpose: 'guest_login' }, env, clock),
      ),
    );
    const codes = results.map((r) =>
      r.status === 'rejected' ? (r.reason as { code: string }).code : 'ok',
    );
    expect(codes.filter((c) => c === 'OTP_INVALID')).toHaveLength(5);
    expect(codes.filter((c) => c === 'OTP_LOCKED')).toHaveLength(15);
    const row = await db
      .selectFrom('haven.otp_challenges')
      .select('attempts')
      .executeTakeFirstOrThrow();
    expect(row.attempts).toBe(5);
    // Even the right code is refused now.
    await expect(
      verifyOtp(db, { phone, code: '111111', purpose: 'guest_login' }, env, clock),
    ).rejects.toMatchObject({ code: 'OTP_LOCKED' });
  });
});

describe('SA-05 / SA-07: OTP request limits hold under parallel load; CAPTCHA from the 4th request per IP', () => {
  it('20 parallel requests for one phone create exactly one challenge (30 s cooldown) and never more than 3', async () => {
    const env = testEnv();
    const bot = new DevBypassBotVerifier();
    const results = await Promise.allSettled(
      Array.from({ length: 20 }, () =>
        requestOtp(
          db,
          { phone: '+919876500777', purpose: 'guest_login', ip: '198.51.100.1' },
          env,
          clock,
          bot,
        ),
      ),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rows = await db.selectFrom('haven.otp_challenges').select('id').execute();
    expect(rows).toHaveLength(1);
  });

  it('parallel requests from one IP for many phones stop at 10 per hour', async () => {
    const env = testEnv();
    const bot = new FakeBot(true);
    const results = await Promise.allSettled(
      Array.from({ length: 25 }, (_, i) =>
        requestOtp(
          db,
          {
            phone: `+9198765${String(10000 + i)}`,
            purpose: 'guest_login',
            ip: '198.51.100.2',
            captchaToken: 'good-token',
          },
          env,
          clock,
          bot,
        ),
      ),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(10);
  });

  it('the first 3 requests from an IP need no CAPTCHA; the 4th needs a token Turnstile accepts', async () => {
    const env = testEnv();
    const bot = new FakeBot(true);
    const ip = '198.51.100.3';
    for (let i = 0; i < 3; i++) {
      await requestOtp(
        db,
        { phone: `+9198765${20000 + i}`, purpose: 'guest_login', ip },
        env,
        clock,
        bot,
      );
    }
    expect(bot.calls).toEqual([]);
    await expect(
      requestOtp(db, { phone: '+919876520010', purpose: 'guest_login', ip }, env, clock, bot),
    ).rejects.toMatchObject({ code: 'RATE_LIMITED', details: { reason: 'CAPTCHA_REQUIRED' } });
    await expect(
      requestOtp(
        db,
        { phone: '+919876520011', purpose: 'guest_login', ip, captchaToken: 'forged' },
        env,
        clock,
        bot,
      ),
    ).rejects.toMatchObject({ details: { reason: 'CAPTCHA_REQUIRED' } });
    await requestOtp(
      db,
      { phone: '+919876520012', purpose: 'guest_login', ip, captchaToken: 'good-token' },
      env,
      clock,
      bot,
    );
  });

  it('the API passes captchaToken through and answers 429 CAPTCHA_REQUIRED', async () => {
    const bot = new FakeBot(true);
    const app = await buildTestApp(clock, { botVerifier: bot });
    const send = (i: number, captchaToken?: string) =>
      supertest(app.server)
        .post('/v1/auth/otp/request')
        .set('X-Forwarded-For', '198.51.100.4')
        .send({
          phone: `98765${30000 + i}`,
          purpose: 'guest_login',
          ...(captchaToken ? { captchaToken } : {}),
        });
    for (let i = 0; i < 3; i++) expect((await send(i)).status).toBe(202);
    const fourth = await send(3);
    expect(fourth.status).toBe(429);
    expect(fourth.body.error).toMatchObject({
      code: 'RATE_LIMITED',
      details: { reason: 'CAPTCHA_REQUIRED' },
    });
    expect((await send(4, 'good-token')).status).toBe(202);
    await app.close();
  });

  it('without TURNSTILE_SECRET only APP_ENV=local may boot (the bypass never reaches staging/production)', async () => {
    for (const APP_ENV of ['staging', 'production']) {
      const env = testEnv({ APP_ENV });
      await expect(
        buildApp({
          env,
          logger: createLogger(env),
          db,
          clock,
          mediaStorage: new MemoryMediaStorage(),
          checkDb: async () => true,
        }),
      ).rejects.toThrow(/TURNSTILE_SECRET is required/);
    }
  });
});

describe('SA-06 / SA-10: OTP verify is limited to 10 per IP per 10 minutes, per real client IP', () => {
  it('the 11th verify from one client IP is refused; another client behind the same proxy is not', async () => {
    const app = await buildTestApp(clock, { env: { TRUST_PROXY_HOPS: '1' } });
    const verify = (ip: string) =>
      supertest(app.server)
        .post('/v1/auth/otp/verify')
        .set('X-Forwarded-For', ip)
        .send({ phone: '9876500999', code: '000000', purpose: 'guest_login' });
    for (let i = 0; i < 10; i++) expect((await verify('203.0.113.10')).status).toBe(400);
    expect((await verify('203.0.113.10')).status).toBe(429);
    expect((await verify('203.0.113.11')).status).toBe(400);
    await app.close();
  });

  it('with no trusted proxy, X-Forwarded-For is ignored (a client can’t pick its own IP)', async () => {
    const app = await buildTestApp(clock);
    for (let i = 0; i < 10; i++) {
      await supertest(app.server)
        .post('/v1/auth/otp/verify')
        .set('X-Forwarded-For', `203.0.113.${100 + i}`)
        .send({ phone: '9876500998', code: '000000', purpose: 'guest_login' });
    }
    const spoofed = await supertest(app.server)
      .post('/v1/auth/otp/verify')
      .set('X-Forwarded-For', '203.0.113.250')
      .send({ phone: '9876500998', code: '000000', purpose: 'guest_login' });
    expect(spoofed.status).toBe(429);
    await app.close();
  });
});

describe('SA-08 / SA-14: logs never carry tokens, signatures or phone numbers', () => {
  it('request URLs are logged without query strings, invite tokens masked', async () => {
    const stream = new PassThrough();
    let logs = '';
    stream.on('data', (c: Buffer) => (logs += c.toString()));
    const app = await buildTestApp(clock, { env: { LOG_LEVEL: 'info' }, logStream: stream });
    const token = 'invite-token-SECRET-1234567890';
    await supertest(app.server).get(`/v1/invites/${token}`);
    await supertest(app.server).get(
      '/v1/media/00000000-0000-4000-8000-000000000000?exp=1&sig=SIGNATURE-XYZ',
    );
    await supertest(app.server).get('/v1/admin/visits?q=%2B919876543210');
    await app.close();
    expect(logs).toContain('/v1/invites/[redacted]');
    expect(logs).not.toContain(token);
    expect(logs).not.toContain('SIGNATURE-XYZ');
    expect(logs).not.toMatch(/9876543210/);
  });

  it('the console OTP line shows a masked phone', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await requestOtp(
      db,
      { phone: '+919876543210', purpose: 'guest_login', ip: null },
      testEnv(),
      clock,
      new DevBypassBotVerifier(),
    );
    const line =
      spy.mock.calls.map((c) => String(c[0])).find((l) => l.startsWith('[otp:dev]')) ?? '';
    spy.mockRestore();
    expect(line).toMatch(/^\[otp:dev\] \+91•••••43210 purpose-code=\d{6}$/);
  });
});

describe('SA-09: JSON bodies over 64 KB are refused; photo uploads still allowed up to 3 MB', () => {
  it('a 70 KB JSON body gets 400, not processed', async () => {
    const app = await buildTestApp(clock);
    const res = await supertest(app.server)
      .post('/v1/auth/otp/request')
      .set('Content-Type', 'application/json')
      .send(
        JSON.stringify({ phone: '9876500111', purpose: 'guest_login', pad: 'x'.repeat(70 * 1024) }),
      );
    expect(res.status).toBe(400);
    expect(await db.selectFrom('haven.otp_challenges').select('id').execute()).toEqual([]);
    await app.close();
  });
});

describe('SA-11: reading residents’ ID documents is audited (T15)', () => {
  it('the pending-residents list writes read.resident_documents', async () => {
    const storage = new MemoryMediaStorage();
    const app = await buildTestApp(clock, { mediaStorage: storage });
    const w = await hostelWorld();
    const r = await pendingResident(w.hostelId, storage);
    const res = await supertest(app.server)
      .get('/v1/admin/residents?status=pending')
      .set('Authorization', `Bearer ${await issueToken(clock, { type: 'user', id: w.wardenId })}`)
      .set('X-Hostel-Id', w.hostelId);
    expect(res.status).toBe(200);
    const audit = await db
      .selectFrom('haven.audit_log')
      .select(['action', 'actor_id', 'after'])
      .where('action', '=', 'read.resident_documents')
      .execute();
    expect(audit).toEqual([
      {
        action: 'read.resident_documents',
        actor_id: w.wardenId,
        after: { residentIds: [r.userId] },
      },
    ]);
    await app.close();
  });
});

describe('SA-16: only HS256 access tokens are accepted', () => {
  it('a token signed HS512 with the same secret is refused', async () => {
    const app = await buildTestApp(clock);
    const w = await hostelWorld();
    const good = await issueToken(clock, { type: 'user', id: w.residentId });
    const claims = JSON.parse(Buffer.from(good.split('.')[1] ?? '', 'base64url').toString());
    const forged = await new SignJWT(claims)
      .setProtectedHeader({ alg: 'HS512' })
      .sign(Buffer.from(JWT_SECRET, 'base64'));
    expect(
      (await supertest(app.server).get('/v1/me').set('Authorization', `Bearer ${good}`)).status,
    ).toBe(200);
    const res = await supertest(app.server).get('/v1/me').set('Authorization', `Bearer ${forged}`);
    expect(res.status).toBe(401);
    await app.close();
  });
});

describe('SA-21: verifying a phone another account owns is a 409', () => {
  it('returns CONFLICT, not 500', async () => {
    const app = await buildTestApp(clock);
    const w = await hostelWorld();
    await db
      .updateTable('haven.users')
      .set({ phone: '+919999900003' })
      .where('id', '=', w.wardenId)
      .execute();
    const res = await supertest(app.server)
      .post('/v1/auth/otp/verify')
      .set('Authorization', `Bearer ${await issueToken(clock, { type: 'user', id: w.residentId })}`)
      .send({ phone: '9999900003', code: '123456', purpose: 'phone_verify' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CONFLICT');
    await app.close();
  });
});

describe('SA-13: errors reach Sentry, scrubbed; nothing is sent without a DSN', () => {
  class FakeReporter implements ErrorReporter {
    seen: { err: unknown; context?: { requestId?: string; tags?: Record<string, string> } }[] = [];
    captureException(
      err: unknown,
      context?: { requestId?: string; tags?: Record<string, string> },
    ) {
      this.seen.push({ err, context });
    }
  }

  it('without SENTRY_DSN the reporter is the no-op', () => {
    expect(createErrorReporter({ APP_ENV: 'local', SENTRY_DSN: undefined })).toBe(NOOP_REPORTER);
  });

  it('an unhandled error is reported with its request id; the response carries no detail', async () => {
    const reporter = new FakeReporter();
    const env = testEnv();
    const app = await buildApp({
      env,
      logger: createLogger(env),
      db,
      clock,
      mediaStorage: new MemoryMediaStorage(),
      checkDb: async () => true,
      errorReporter: reporter,
    });
    app.get('/v1/__boom', async () => {
      throw new Error('boom for +919876543210');
    });
    await app.ready();
    const res = await supertest(app.server).get('/v1/__boom');
    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain('boom');
    expect(reporter.seen).toHaveLength(1);
    expect(reporter.seen[0]?.context?.requestId).toBe(res.body.error.requestId);
    await app.close();
  });

  it('a permanently failed notification is reported by kind and channel, never its text or phone', async () => {
    const reporter = new FakeReporter();
    const row = await db
      .insertInto('haven.notifications')
      .values({
        recipient_type: 'phone',
        recipient_phone: '+919812300001',
        kind: 'N-OVERSTAY-GUEST',
        channel: 'sms',
        body: 'Not the template',
        sms_template_id: 'HAVEN_OVERSTAY',
        data: JSON.stringify({ smsVars: ['4:30 pm'] }),
        next_attempt_at: NOW,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await new NotificationWorker({
      db,
      clock,
      push: new FakePushSender(),
      sms: new FakeSmsSender(),
      reporter,
    }).tick();
    expect(reporter.seen).toHaveLength(1);
    expect(reporter.seen[0]?.context?.tags).toEqual({
      kind: 'N-OVERSTAY-GUEST',
      channel: 'sms',
      notification_id: row.id,
    });
    expect(String((reporter.seen[0]?.err as Error).message)).not.toMatch(
      /9812300001|Not the template/,
    );
  });
});

describe('SA-15: a /v1 handler that never calls authorize() fails closed', () => {
  async function appWith(register: (app: FastifyInstance) => void) {
    const env = testEnv();
    const reporter = {
      seen: [] as unknown[],
      captureException(e: unknown) {
        this.seen.push(e);
      },
    };
    const app = await buildApp({
      env,
      logger: createLogger(env),
      db,
      clock,
      mediaStorage: new MemoryMediaStorage(),
      checkDb: async () => true,
      errorReporter: reporter,
    });
    register(app);
    await app.ready();
    return { app, reporter };
  }

  it('a successful response without authorize() becomes a 500 and is reported', async () => {
    const { app, reporter } = await appWith((a) => {
      a.get('/v1/__forgot', async () => ({ secret: 'data' }));
    });
    const res = await supertest(app.server).get('/v1/__forgot');
    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain('data');
    expect(String(reporter.seen[0])).toMatch(/without authorize\(\): GET \/v1\/__forgot/);
    await app.close();
  });

  it('the same handler with authorize() answers normally; /health is not a /v1 handler', async () => {
    const { authorize } = await import('../src/auth/policy.js');
    const { app } = await appWith((a) => {
      a.get('/v1/__checked', async (request) => {
        authorize(request.principal ?? null, 'hostels.list', {});
        return { ok: true };
      });
    });
    expect((await supertest(app.server).get('/v1/__checked')).status).toBe(200);
    expect((await supertest(app.server).get('/health')).status).toBe(200);
    await app.close();
  });
});

describe('SA-19: browsers never receive the refresh token in a response body', () => {
  it('X-Client: native is honoured only without an Origin header', async () => {
    const app = await buildTestApp(clock);
    const signIn = (headers: Record<string, string>) =>
      supertest(app.server)
        .post('/v1/auth/otp/verify')
        .set(headers)
        .send({ phone: '9999900001', code: '123456', purpose: 'guest_login' });

    const native = await signIn({ 'X-Client': 'native' });
    expect(native.status).toBe(200);
    expect(typeof native.body.refreshToken).toBe('string');

    const browser = await signIn({ 'X-Client': 'native', Origin: 'https://app.haven.test' });
    expect(browser.status).toBe(200);
    expect(browser.body.refreshToken).toBeUndefined();
    expect(String(browser.headers['set-cookie'])).toMatch(/haven_rt=[^;]+;.*HttpOnly/i);
    await app.close();
  });
});
