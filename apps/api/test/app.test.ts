import type { FastifyInstance } from 'fastify';
import supertest from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { __resetEnvCacheForTests, loadEnv } from '../src/config.js';
import { createDb } from '../src/db/index.js';
import { createLogger } from '../src/lib/logger.js';

/**
 * Infrastructure smoke tests only (health/ready/error-envelope shape). No business
 * routes exist yet to test — those land with their owning feature module.
 */
describe('GET /health and GET /ready', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    __resetEnvCacheForTests();
    const env = loadEnv({
      DATABASE_URL: 'postgres://user:pass@localhost:6543/postgres',
      DATABASE_DIRECT_URL: 'postgres://user:pass@localhost:5432/postgres',
      LOG_LEVEL: 'silent',
    });
    const logger = createLogger(env);
    const db = createDb(env);

    app = buildApp({
      env,
      logger,
      db,
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
});

describe('GET /ready when the DB check fails', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    __resetEnvCacheForTests();
    const env = loadEnv({
      DATABASE_URL: 'postgres://user:pass@localhost:6543/postgres',
      DATABASE_DIRECT_URL: 'postgres://user:pass@localhost:5432/postgres',
      LOG_LEVEL: 'silent',
    });
    const logger = createLogger(env);
    const db = createDb(env);

    app = buildApp({ env, logger, db, checkDb: async () => false });
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
