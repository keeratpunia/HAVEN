#!/usr/bin/env node
/* eslint-disable no-console -- CLI script */
/**
 * Phase 1 test version (DEC-026, DEC-028): set up the hosted Supabase database from your
 * own computer. Reads `apps/api/.env.staging.local` (gitignored — never commit it; see
 * docs/DEPLOY-TEST.md for what goes in it).
 *
 *   pnpm --filter @haven/api run staging -- migrate   apply supabase/migrations that aren't applied yet,
 *                                                     and set haven_api's password
 *   pnpm --filter @haven/api run staging -- seed      the dummy GH-8 world (refuses if already seeded)
 *   pnpm --filter @haven/api run staging -- reset     wipe everything HAVEN stored, migrate, seed again
 *
 * Every command refuses to run unless the file says APP_ENV=staging. `reset` also asks
 * you to type the project's host name back. It never runs against production: Phase 2
 * is a different Supabase project with its own credentials, which never go in this file.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { parseDataEncryptionKey, randomSecret } from '../src/lib/crypto.js';
import { generateGateCode } from '../src/lib/ids.js';
import { pgConnectionOptions } from '../src/db/ssl.js';
import { SupabaseMediaStorage } from '../src/media/supabase-storage.js';
import type { MediaBucket } from '../src/gate/media.js';
import { seedDemoWorld, SEED_PEOPLE, TEST_PHONES } from './seed-fixtures.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const API_DIR = path.resolve(__dirname, '..');
const ENV_FILE = path.join(API_DIR, '.env.staging.local');
const MIGRATIONS_DIR = path.resolve(API_DIR, '../../supabase/migrations');

function fail(message: string): never {
  console.error(`\n${message}\n`);
  process.exit(1);
}

function required(name: string): string {
  const value = process.env[name];
  if (!value)
    fail(`${name} is missing from apps/api/.env.staging.local (see docs/DEPLOY-TEST.md).`);
  return value;
}

function loadStagingEnv(): void {
  if (!existsSync(ENV_FILE)) {
    fail('apps/api/.env.staging.local not found. Create it first (docs/DEPLOY-TEST.md, step 2).');
  }
  process.loadEnvFile(ENV_FILE);
  if (process.env.APP_ENV !== 'staging') {
    fail(
      `Refusing to run: apps/api/.env.staging.local has APP_ENV=${process.env.APP_ENV ?? '(unset)'}. ` +
        'These commands are for the test version only (APP_ENV=staging).',
    );
  }
}

async function connect(): Promise<pg.Client> {
  const url = required('MIGRATION_DATABASE_URL');
  if (new URL(url).port === '6543') {
    fail(
      'MIGRATION_DATABASE_URL must be the session pooler (port 5432), not the transaction pooler (6543).',
    );
  }
  const client = new pg.Client(pgConnectionOptions(url, process.env.DATABASE_CA_CERT || undefined));
  await client.connect();
  return client;
}

function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith('.sql'))
    .sort();
}

/** Applies every migration not yet recorded, each in its own transaction. */
async function migrate(client: pg.Client): Promise<void> {
  // The table the Supabase CLI itself uses, so `supabase migration list` agrees later.
  await client.query('create schema if not exists supabase_migrations');
  await client.query(
    `create table if not exists supabase_migrations.schema_migrations
       (version text primary key, statements text[], name text)`,
  );
  const applied = new Set(
    (
      await client.query<{ version: string }>(
        'select version from supabase_migrations.schema_migrations',
      )
    ).rows.map((r) => r.version),
  );
  let count = 0;
  for (const file of migrationFiles()) {
    const [version, ...rest] = file.replace(/\.sql$/, '').split('_');
    if (!version || applied.has(version)) continue;
    const sqlText = readFileSync(path.join(MIGRATIONS_DIR, file), 'utf-8');
    console.log(`  applying ${file}`);
    await client.query('begin');
    try {
      await client.query(sqlText);
      await client.query(
        'insert into supabase_migrations.schema_migrations (version, name) values ($1, $2)',
        [version, rest.join('_')],
      );
      await client.query('commit');
    } catch (err) {
      await client.query('rollback');
      throw err;
    }
    count += 1;
  }
  console.log(count ? `Applied ${count} migration(s).` : 'Database already up to date.');

  // SDD §11.7: the API logs in as haven_api with a password from the secret store. The
  // migration creates the role with a local-only placeholder; replace it here. The
  // value goes in as a bind parameter and is quoted by the server (format %L), never
  // pasted into SQL text here.
  const password = required('HAVEN_API_DB_PASSWORD');
  if (password.length < 24)
    fail('HAVEN_API_DB_PASSWORD must be at least 24 characters (use the generator).');
  await client.query(`select set_config('haven.api_password', $1, false)`, [password]);
  await client.query(
    `do $$ begin
       execute format('alter role haven_api with login password %L', current_setting('haven.api_password'));
     end $$`,
  );
  await client.query(`select set_config('haven.api_password', '', false)`);
  console.log('haven_api password set.');

  const cron = await client.query<{ n: number }>(
    `select count(*)::int as n from pg_extension where extname = 'pg_cron'`,
  );
  console.log(
    cron.rows[0]?.n
      ? 'pg_cron is on: the timed jobs run inside Supabase even while the API sleeps.'
      : 'WARNING: pg_cron is not installed — timed jobs will only run while the API is awake.',
  );
}

function storage(): SupabaseMediaStorage {
  const url = new URL(required('SUPABASE_URL'));
  if (url.pathname !== '/') {
    fail(
      `SUPABASE_URL must be just the project URL, e.g. https://${url.hostname} — remove "${url.pathname}".`,
    );
  }
  return new SupabaseMediaStorage(url.origin, required('SUPABASE_SERVICE_ROLE_KEY'));
}

function gatePosition(): { lat: number; lng: number } | null {
  const lat = process.env.SEED_GATE_LAT;
  const lng = process.env.SEED_GATE_LNG;
  if (!lat || !lng) return null;
  const pos = { lat: Number(lat), lng: Number(lng) };
  if (!Number.isFinite(pos.lat) || !Number.isFinite(pos.lng))
    fail('SEED_GATE_LAT/SEED_GATE_LNG must be numbers.');
  return pos;
}

async function seed(client: pg.Client): Promise<void> {
  const existing = await client.query(`select 1 from haven.hostels where code = 'GH-8'`);
  if (existing.rowCount) {
    fail(
      'The test database already has GH-8. To start again with fresh dummy data, run: staging -- reset',
    );
  }
  const media = storage();
  const radiusM = Number(process.env.SEED_GATE_RADIUS_M ?? '200');
  if (!Number.isInteger(radiusM) || radiusM < 10 || radiusM > 300)
    fail('SEED_GATE_RADIUS_M must be 10–300.');
  const position = gatePosition();

  await client.query('begin');
  let result;
  try {
    result = await seedDemoWorld(client, {
      writeMedia: (bucket, mediaPath, bytes) => media.put({ bucket, path: mediaPath }, bytes),
      gate: {
        code: generateGateCode(),
        // A fresh random gate secret, encrypted with the same key the API uses.
        secret: randomSecret(),
        dataEncryptionKey: parseDataEncryptionKey(required('DATA_ENCRYPTION_KEY')),
        position,
        radiusM,
      },
      seedNow: Date.now(),
    });
    await client.query('commit');
  } catch (err) {
    await client.query('rollback');
    throw err;
  }

  console.log('\nDummy data is in. Sign in at the web address with a test number (code 123456):');
  console.log(`  Resident ${SEED_PEOPLE.resident1.name} (room 101)  ${TEST_PHONES.resident1}`);
  console.log(`  Resident ${SEED_PEOPLE.resident2.name} (room 102)  ${TEST_PHONES.resident2}`);
  console.log(
    `  Waiting for verification: ${SEED_PEOPLE.pendingResident.name}  ${TEST_PHONES.pendingResident}`,
  );
  console.log(`  Warden ${SEED_PEOPLE.warden.name}  ${TEST_PHONES.warden}`);
  console.log(`  Office ${SEED_PEOPLE.office.name}  ${TEST_PHONES.office}`);
  console.log(`  Admin ${SEED_PEOPLE.superAdmin.name}  ${TEST_PHONES.superAdmin}`);
  console.log('  Guests: +91 99999 00001, 00002, 00003');
  console.log(
    position
      ? `Gate location set from SEED_GATE_LAT/LNG, radius ${radiusM} m.`
      : `Gate location not set yet (radius ${radiusM} m): the admin sets it from Gates → "Set gate location to my current position".`,
  );
  console.log(
    `Gate pairing code: ${result.pairingCode} (valid until ${result.pairingExpiresAt.toLocaleTimeString()}; ` +
      'the admin can make a new one from Gates → Add device).',
  );
}

/** Drops everything HAVEN stored (schema, photos, cron jobs) so migrate + seed start clean. */
async function wipe(client: pg.Client): Promise<void> {
  const hasSchema = await client.query(`select 1 from pg_namespace where nspname = 'haven'`);
  if (hasSchema.rowCount) {
    const media = storage();
    const files = await client.query<{ bucket: string; path: string }>(
      `select bucket, path from haven.media where deleted_at is null`,
    );
    for (const f of files.rows) {
      await media
        .delete({ bucket: f.bucket as MediaBucket, path: f.path })
        .catch((err: unknown) => {
          console.warn(`  could not delete ${f.bucket}/${f.path}: ${String(err)}`);
        });
    }
    console.log(`  deleted ${files.rowCount} photo(s) from Storage`);
  }
  const hasCron = await client.query(`select 1 from pg_extension where extname = 'pg_cron'`);
  if (hasCron.rowCount) {
    await client.query(`select cron.unschedule(jobid) from cron.job where jobname like 'haven-%'`);
  }
  await client.query('drop schema if exists haven cascade');
  const hasTable = await client.query(
    `select 1 from information_schema.tables where table_schema = 'supabase_migrations' and table_name = 'schema_migrations'`,
  );
  if (hasTable.rowCount) {
    const versions = migrationFiles().map((f) => f.split('_')[0]);
    await client.query(
      'delete from supabase_migrations.schema_migrations where version = any($1)',
      [versions],
    );
  }
  console.log('  dropped schema haven');
}

async function main() {
  // `pnpm run staging -- seed` passes the `--` through.
  const command = process.argv.slice(2).find((a) => a !== '--');
  if (!['migrate', 'seed', 'reset'].includes(command ?? '')) {
    fail('Usage: pnpm --filter @haven/api run staging -- migrate | seed | reset');
  }
  loadStagingEnv();
  const host = new URL(required('MIGRATION_DATABASE_URL')).hostname;
  const project = new URL(required('SUPABASE_URL')).hostname;
  console.log(`Test version database: ${host} (Supabase project ${project})`);

  if (command === 'reset') {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await rl.question(
      `\nThis deletes ALL data and photos in the test version and puts fresh dummy data in.\n` +
        `Type the project's host name to confirm (${project}): `,
    );
    rl.close();
    if (answer.trim() !== project) fail('Not confirmed. Nothing was changed.');
  }

  const client = await connect();
  try {
    if (command === 'reset') {
      console.log('Wiping...');
      await wipe(client);
    }
    if (command === 'migrate' || command === 'reset') {
      console.log('Migrating...');
      await migrate(client);
    }
    if (command === 'seed' || command === 'reset') {
      console.log('Seeding...');
      await seed(client);
    }
  } finally {
    await client.end();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
