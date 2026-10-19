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
import { formatIst, OffsetClock, parseDemoTime } from './demo-time.js';
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
    // Behind `pnpm demo:tunnel` every request arrives via cloudflared → demo-proxy, so
    // the phone's own IP is the one X-Forwarded-For entry cloudflared adds. Without
    // this, every phone and the laptop share 127.0.0.1 for the per-IP limits.
    TRUST_PROXY_HOPS: process.env.TRUST_PROXY_HOPS ?? '0',
    JWT_SECRET: DEMO_JWT_SECRET,
    OTP_PEPPER: DEMO_OTP_PEPPER,
    GOOGLE_CLIENT_IDS: 'demo-unused-client-id',
    SMS_PROVIDER: 'console',
    DATA_ENCRYPTION_KEY: DEMO_DATA_ENCRYPTION_KEY,
    DEV_LOGIN_ENABLED: 'true',
    // The one instance running the outbox worker and, with no pg_cron here, the §9.8
    // jobs (overstay flags, gate offline alerts), so the warden dashboard stays live.
    WORKER_ENABLED: 'true',
  });
  const logger = createLogger(env);
  const db = createDb(env);
  // Real time unless the presenter moves it (`pnpm demo:clock`, docs/DEMO.md step F).
  const clock = new OffsetClock();
  const mediaStorage = new LocalDiskMediaStorage(path.join(process.cwd(), '.demo-media'));
  const app = await buildApp({
    env,
    logger,
    db,
    clock,
    mediaStorage,
    // One presenter laptop runs the warden, office, resident and gate screens (each
    // polling) through one tunnel, so SDD §12.11's 120/min per IP — sized for one
    // person's phone — is raised for the demo only. Route limits (OTP, scans) stay.
    rateLimit: { max: 1_000, timeWindowMs: 60_000 },
  });

  // Demo-only clock control (`pnpm demo:clock`). Outside /v1, loopback callers only:
  // the tunnel proxy forwards /v1 to this server and everything else to the web app,
  // so a phone can never reach it.
  const loopback = (ip: string) => ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
  const clockState = () => ({
    now: clock.now().toISOString(),
    offsetMinutes: Math.round(clock.offset / 60_000),
  });
  app.get('/__demo/clock', async (request, reply) => {
    if (!loopback(request.socket.remoteAddress ?? '')) return reply.code(404).send();
    return clockState();
  });
  app.post('/__demo/clock', async (request, reply) => {
    if (!loopback(request.socket.remoteAddress ?? '')) return reply.code(404).send();
    const { at } = (request.body ?? {}) as { at?: string };
    try {
      const target = parseDemoTime(at ?? 'reset', clock.now());
      if (target) clock.setNow(target);
      else clock.reset();
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
    console.log(`[demo clock] now ${formatIst(clock.now())}`);
    return clockState();
  });

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
