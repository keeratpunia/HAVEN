#!/usr/bin/env node
/* eslint-disable no-console -- CLI script */
/**
 * Production start check (FINAL-QA-REPORT D-02; CI step "Production start check").
 *
 * Starts `node dist/server.js` — the exact production entry point, no tsx — with a
 * production-shaped environment (NODE_ENV=production, APP_ENV=staging, every required
 * secret set) against a real Postgres with the real migrations, then requires
 * GET /health and GET /ready to answer 200. Exits non-zero otherwise.
 *
 * Postgres: `CHECK_DATABASE_URL` if given (CI may provide a service), else an embedded
 * Postgres started here and removed afterwards.
 *
 * Run after `pnpm --filter @haven/api build`:
 *   pnpm --filter @haven/api run check:prod-start
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import EmbeddedPostgres from 'embedded-postgres';

const here = path.dirname(fileURLToPath(import.meta.url));
const apiDir = path.resolve(here, '..');
const migrationsDir = path.resolve(apiDir, '../../supabase/migrations');
const PG_PORT = 54_650;
const API_PORT = 8_095;

async function startPostgres(): Promise<{ url: string; stop: () => Promise<void> }> {
  if (process.env.CHECK_DATABASE_URL) {
    return { url: process.env.CHECK_DATABASE_URL, stop: async () => {} };
  }
  const dir = mkdtempSync(path.join(tmpdir(), 'haven-prod-check-pg-'));
  const pg = new EmbeddedPostgres({
    databaseDir: dir,
    port: PG_PORT,
    user: 'postgres',
    password: 'postgres',
    persistent: false,
    initdbFlags: ['--encoding=UTF8', '--locale=C'],
    onLog: () => {},
  });
  await pg.initialise();
  await pg.start();
  await pg.createDatabase('haven_check');
  const client = pg.getPgClient('haven_check');
  await client.connect();
  await client.query('create extension if not exists citext');
  await client.query('create extension if not exists pgcrypto');
  for (const file of readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort()) {
    await client.query(readFileSync(path.join(migrationsDir, file), 'utf8'));
  }
  await client.end();
  return {
    url: `postgres://postgres:postgres@127.0.0.1:${PG_PORT}/haven_check`,
    stop: async () => {
      await pg.stop();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function poll(url: string, deadline: number): Promise<{ status: number; body: string }> {
  let last = { status: 0, body: 'no response' };
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      last = { status: res.status, body: await res.text() };
      if (res.status === 200) return last;
    } catch (err) {
      last = { status: 0, body: String(err) };
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return last;
}

async function main() {
  const db = await startPostgres();
  const key = () => randomBytes(32).toString('base64');
  const server = spawn(process.execPath, ['dist/server.js'], {
    cwd: apiDir,
    env: {
      PATH: process.env.PATH ?? '',
      SystemRoot: process.env.SystemRoot ?? '',
      NODE_ENV: 'production',
      APP_ENV: 'staging',
      PORT: String(API_PORT),
      LOG_LEVEL: 'warn',
      DATABASE_URL: db.url,
      DATABASE_DIRECT_URL: db.url,
      JWT_SECRET: key(),
      OTP_PEPPER: key(),
      DATA_ENCRYPTION_KEY: key(),
      GOOGLE_CLIENT_IDS: 'check-client-id',
      TURNSTILE_SECRET: 'check-turnstile-secret',
      API_BASE_URL: 'https://api.haven.example',
      WEB_BASE_URL: 'https://app.haven.example',
      CORS_ORIGINS: 'https://app.haven.example',
      COOKIE_DOMAIN: 'haven.example',
      SUPABASE_URL: 'https://storage.haven.example',
      SUPABASE_SERVICE_ROLE_KEY: 'check-service-role-key',
      WORKER_ENABLED: 'true',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  server.stdout.on('data', (b: Buffer) => (output += b.toString()));
  server.stderr.on('data', (b: Buffer) => (output += b.toString()));
  const exited = new Promise<number | null>((resolve) => server.on('exit', resolve));

  const deadline = Date.now() + 30_000;
  const health = await poll(`http://127.0.0.1:${API_PORT}/health`, deadline);
  const ready = await poll(`http://127.0.0.1:${API_PORT}/ready`, deadline);
  server.kill();
  await Promise.race([exited, new Promise((r) => setTimeout(r, 5_000))]);
  await db.stop();

  console.log(`GET /health -> ${health.status} ${health.body}`);
  console.log(`GET /ready  -> ${ready.status} ${ready.body}`);
  if (health.status !== 200 || ready.status !== 200) {
    console.error('Production start check FAILED. Server output:\n' + output);
    process.exit(1);
  }
  console.log('Production start check passed: node dist/server.js serves /health and /ready.');
}

void main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
