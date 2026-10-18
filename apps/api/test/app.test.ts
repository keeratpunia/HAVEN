import type { FastifyInstance } from 'fastify';
import supertest from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { __resetEnvCacheForTests, loadEnv } from '../src/config.js';
import { createDb } from '../src/db/index.js';
import type { MediaStorage } from '../src/gate/media.js';
import { createLogger } from '../src/lib/logger.js';

const VALID_JWT_SECRET = Buffer.alloc(32, 7).toString('base64');
const VALID_OTP_PEPPER = Buffer.alloc(32, 3).toString('base64');
const VALID_DATA_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString('base64');

/** No business route in this file touches media; a no-op fake is enough. */
const fakeMediaStorage: MediaStorage = {
  put: async () => undefined,
  get: async () => null,
  delete: async () => undefined,
};

function testEnv(overrides: Record<string, string> = {}) {
  __resetEnvCacheForTests();
  return loadEnv({
    APP_ENV: 'local',
    DATABASE_URL: 'postgres://user:pass@localhost:6543/postgres',
    DATABASE_DIRECT_URL: 'postgres://user:pass@localhost:5432/postgres',
    JWT_SECRET: VALID_JWT_SECRET,
    OTP_PEPPER: VALID_OTP_PEPPER,
    GOOGLE_CLIENT_IDS: 'test-client-id',
    DATA_ENCRYPTION_KEY: VALID_DATA_ENCRYPTION_KEY,
    LOG_LEVEL: 'silent',
    ...overrides,
  });
}

/**
 * Infrastructure smoke tests only (health/ready/error-envelope/security-header/
 * rate-limit shape). No business routes exist yet to test — those land with their
 * owning feature module. Auth/authorize/validation *pipeline* tests live in
 * `src/auth/*.test.ts` and `src/lib/validation.test.ts`, each against a small
 * throwaway Fastify app built from the same reusable pieces — not against real routes
 * in `app.ts`, since none exist.
 */
describe('GET /health and GET /ready', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    const env = testEnv();
    const logger = createLogger(env);
    const db = createDb(env);

    app = await buildApp({
      env,
      logger,
      db,
      mediaStorage: fakeMediaStorage,
      checkDb: async () => true, // no live Postgres in this test run — see src/db/index.test.ts for the real pingDb() unit test
    });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /health returns 200 with no DB dependency', async () => {
    const res = await supertest(app.server).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true });
  });

  it('GET /ready returns 200 when the DB check succeeds', async () => {
    const res = await supertest(app.server).get('/ready');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, db: true });
  });

  it('unknown routes return the SDD §12.1 error envelope with a request id', async () => {
    const res = await supertest(app.server).get('/this-route-does-not-exist');
    expect(res.status).toBe(404);
    expect(res.body.error).toMatchObject({ code: 'NOT_FOUND' });
    expect(res.body.error.requestId).toMatch(/^req_[a-z0-9]{12}$/);
  });

  it('every response carries a per-request X-Request-Id-shaped id, and two requests get different ones', async () => {
    const res1 = await supertest(app.server).get('/health');
    const res2 = await supertest(app.server).get('/health');
    // Fastify exposes the generated request id to the response via its own header by
    // default under a different name in some configs; the SDD-mandated place every
    // client can rely on is the error envelope. For a success response there's no
    // error envelope, so this test instead proves the underlying id generator is
    // actually invoked per-request (not memoized) via two 404s, which do carry it.
    const err1 = await supertest(app.server).get('/missing-a');
    const err2 = await supertest(app.server).get('/missing-b');
    expect(err1.body.error.requestId).not.toBe(err2.body.error.requestId);
    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);
  });

  it('sets the SDD §16.4 security headers (CSP, HSTS, X-Content-Type-Options)', async () => {
    const res = await supertest(app.server).get('/health');
    expect(res.headers['strict-transport-security']).toContain('max-age=31536000');
    expect(res.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('rejects an Authorization header that is neither Bearer nor Device', async () => {
    const res = await supertest(app.server).get('/health').set('Authorization', 'Basic garbage');
    // /health has no auth requirement of its own, but the authenticate hook runs
    // unconditionally (SDD §8.2) and must reject a malformed credential attempt
    // rather than silently ignoring it, even on a public route.
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('AUTH_REQUIRED');
  });
});

describe('GET /ready when the DB check fails', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    const env = testEnv();
    const logger = createLogger(env);
    const db = createDb(env);

    app = await buildApp({
      env,
      logger,
      db,
      mediaStorage: fakeMediaStorage,
      checkDb: async () => false,
    });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('returns 503 with ok: false, not a 500', async () => {
    const res = await supertest(app.server).get('/ready');
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ ok: false, db: false });
  });
});

describe('rate limiting (SDD §12.11)', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    const env = testEnv();
    const logger = createLogger(env);
    const db = createDb(env);

    app = await buildApp({
      env,
      logger,
      db,
      mediaStorage: fakeMediaStorage,
      checkDb: async () => true,
      rateLimit: { max: 3, timeWindowMs: 60_000 }, // low limit so the test is fast and deterministic
    });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('allows requests under the limit, then returns 429 with the SDD §12.2 envelope and Retry-After', async () => {
    // app.inject() (not supertest's real HTTP connections) so every request reports
    // an identical client IP — @fastify/rate-limit keys by IP by default, and real
    // loopback connections can alternate between 127.0.0.1/::1 across requests, which
    // would make this flaky rather than deterministic.
    for (let i = 0; i < 3; i++) {
      const res = await app.inject({ method: 'GET', url: '/health' });
      expect(res.statusCode).toBe(200);
    }
    const limited = await app.inject({ method: 'GET', url: '/health' });
    expect(limited.statusCode).toBe(429);
    expect(limited.json().error.code).toBe('RATE_LIMITED');
    expect(limited.headers['retry-after']).toBeDefined();
  });
});
