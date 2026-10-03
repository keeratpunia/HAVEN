#!/usr/bin/env node
/* eslint-disable no-console -- CLI script */
/**
 * API server for the guest-web Playwright E2E suite: real app, real DB (started by
 * `e2e-db.ts`), but a `FakeClock` frozen at the same "now" the fixtures were computed
 * against (`E2E_FIXED_NOW`) — so the rules engine's time-of-day checks
 * (`AFTER_HARD_CUTOFF` etc.) behave the same no matter what time of day the test
 * actually runs in CI. Dev/E2E-only; never used in `server.ts`.
 */
import { buildApp } from '../src/app.js';
import { __resetEnvCacheForTests, loadEnv } from '../src/config.js';
import { createDb } from '../src/db/index.js';
import { createLogger } from '../src/lib/logger.js';
import { FakeClock } from '../src/lib/clock.js';
import { E2E_DATABASE_URL, E2E_FIXED_NOW } from './e2e-constants.js';

async function main() {
  __resetEnvCacheForTests();
  const env = loadEnv({
    APP_ENV: 'local',
    PORT: '8080',
    LOG_LEVEL: 'info',
    DATABASE_URL: E2E_DATABASE_URL,
    DATABASE_DIRECT_URL: E2E_DATABASE_URL,
    JWT_SECRET: Buffer.alloc(32, 9).toString('base64'),
    OTP_PEPPER: Buffer.alloc(32, 4).toString('base64'),
    GOOGLE_CLIENT_IDS: 'e2e-client-id',
    SMS_PROVIDER: 'console',
    CORS_ORIGINS: 'http://localhost:8081,http://127.0.0.1:8081',
  });
  const logger = createLogger(env);
  const db = createDb(env);
  const clock = new FakeClock(E2E_FIXED_NOW);
  const app = await buildApp({ env, logger, db, clock });

  await app.listen({ port: env.PORT, host: '0.0.0.0' });
  console.log(
    `HAVEN E2E API listening on :${env.PORT}, clock frozen at ${E2E_FIXED_NOW.toISOString()}`,
  );

  const shutdown = async () => {
    await app.close();
    await db.destroy();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

void main();
