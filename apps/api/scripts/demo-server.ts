#!/usr/bin/env node
/* eslint-disable no-console -- CLI script */
/**
 * API server for the live demo: real app, real DB (started by `demo-db.ts`), and the
 * REAL `SystemClock` — unlike the Playwright E2E suite, this demo must behave exactly
 * as a real deployment would at whatever time of day it's actually run, since the
 * person watching needs to see genuine rule evaluation (cutoffs, windows) happen live.
 *
 * `DEV_LOGIN_ENABLED=true` and `NODE_ENV=development` are both set here, deliberately
 * and only here — `buildApp` independently refuses to start with the flag on unless
 * `NODE_ENV=development` (docs/DECISIONS.md DEC-011), so this script sets both halves
 * of that gate itself rather than relying on an operator's shell. This process only
 * ever points at the embedded, localhost-only demo database from demo-constants.ts —
 * there is no DATABASE_URL override here, so it is structurally incapable of running
 * against staging or production.
 *
 * `WEB_BASE_URL`/`API_BASE_URL`/`CORS_ORIGINS` read from the environment (falling back
 * to plain localhost) so the demo can be re-pointed at a tunnel's HTTPS URL without
 * editing this file — see docs/DEMO.md.
 */
process.env.NODE_ENV = 'development';

import path from 'node:path';
import { buildApp } from '../src/app.js';
import { __resetEnvCacheForTests, loadEnv } from '../src/config.js';
import { createDb } from '../src/db/index.js';
import { LocalDiskMediaStorage } from '../src/gate/media.js';
import { createLogger } from '../src/lib/logger.js';
import { SystemClock } from '../src/lib/clock.js';
import {
  DEMO_API_PORT,
  DEMO_DATA_ENCRYPTION_KEY,
  DEMO_DATABASE_URL,
  DEMO_JWT_SECRET,
  DEMO_OTP_PEPPER,
  DEMO_WEB_PORT,
} from './demo-constants.js';

async function main() {
  const webBaseUrl = process.env.WEB_BASE_URL ?? `http://localhost:${DEMO_WEB_PORT}`;
  const apiBaseUrl = process.env.API_BASE_URL ?? `http://localhost:${DEMO_API_PORT}`;
  const corsOrigins = process.env.CORS_ORIGINS ?? `${webBaseUrl},http://localhost:${DEMO_WEB_PORT}`;

  __resetEnvCacheForTests();
  const env = loadEnv({
    APP_ENV: 'local',
    PORT: String(DEMO_API_PORT),
    LOG_LEVEL: 'info',
    DATABASE_URL: DEMO_DATABASE_URL,
    DATABASE_DIRECT_URL: DEMO_DATABASE_URL,
    API_BASE_URL: apiBaseUrl,
    WEB_BASE_URL: webBaseUrl,
    CORS_ORIGINS: corsOrigins,
    COOKIE_DOMAIN: process.env.COOKIE_DOMAIN ?? 'localhost',
    JWT_SECRET: DEMO_JWT_SECRET,
    OTP_PEPPER: DEMO_OTP_PEPPER,
    GOOGLE_CLIENT_IDS: 'demo-unused-client-id',
    SMS_PROVIDER: 'console',
    DATA_ENCRYPTION_KEY: DEMO_DATA_ENCRYPTION_KEY,
    DEV_LOGIN_ENABLED: 'true',
  });
  const logger = createLogger(env);
  const db = createDb(env);
  const clock = new SystemClock();
  const mediaStorage = new LocalDiskMediaStorage(path.join(process.cwd(), '.demo-media'));
  const app = await buildApp({ env, logger, db, clock, mediaStorage });

  await app.listen({ port: env.PORT, host: '0.0.0.0' });
  console.log(`HAVEN demo API listening on :${env.PORT} (WEB_BASE_URL=${webBaseUrl})`);
  console.log('OTP codes print here as [otp:dev] <phone> purpose-code=<code>.');

  const shutdown = async () => {
    await app.close();
    await db.destroy();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

void main();
