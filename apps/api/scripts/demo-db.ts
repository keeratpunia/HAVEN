#!/usr/bin/env node
/* eslint-disable no-console -- CLI script */
/**
 * Starts one embedded-Postgres instance, applies the real schema migration, and
 * inserts a realistic demo seed: the GH-8 hostel, its real rules config, one gate at
 * configurable coordinates (DEMO_GATE_LAT/DEMO_GATE_LNG — set these to the actual
 * presentation room), two verified residents, a warden, an office user and a super
 * admin, enough visits and charges to make the warden dashboard meaningful (all from
 * `seed-fixtures.ts`, shared with the deployed test version), and a
 * fresh 10-minute gate pairing
 * code printed to the console so the presentation laptop/phone can pair into the
 * actual gate device via /gate/pair.
 *
 * Demo-only, mirrors e2e-db.ts's embedded-postgres pattern (docs/DECISIONS.md
 * DEC-004/DEC-007/DEC-009) but on its own port/DB name and with the REAL clock in
 * demo-server.ts, not a frozen one — this is meant to be run live, not against a
 * fixed "now". Stays running in the foreground until killed.
 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import EmbeddedPostgres from 'embedded-postgres';
import { clearStaleDataDir, stopPostgresSafely } from './fs-safe.js';
import { parseDataEncryptionKey } from '../src/lib/crypto.js';
import { seedDemoWorld } from './seed-fixtures.js';
import {
  DEMO_DATA_ENCRYPTION_KEY,
  DEMO_DATABASE_URL,
  DEMO_GATE_CODE,
  DEMO_GATE_SECRET,
  DEMO_PG_DB,
  DEMO_PG_PASSWORD,
  DEMO_PG_PORT,
  DEMO_PG_USER,
  DEMO_RESIDENT_1_EMAIL,
  DEMO_RESIDENT_2_EMAIL,
  DEMO_OFFICE_EMAIL,
  DEMO_SUPER_ADMIN_EMAIL,
  DEMO_WARDEN_EMAIL,
  demoGateLat,
  demoGateLng,
  demoGateRadiusM,
} from './demo-constants.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(__dirname, '../../../supabase/migrations');

/** Every `.sql` migration, in filename order (timestamp-prefixed, so this is also chronological). */
function allMigrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith('.sql'))
    .sort()
    .map((name) => path.join(MIGRATIONS_DIR, name));
}

async function main() {
  const dataDir = path.join(process.cwd(), '.demo-pgdata');
  const pg = new EmbeddedPostgres({
    databaseDir: dataDir,
    port: DEMO_PG_PORT,
    user: DEMO_PG_USER,
    password: DEMO_PG_PASSWORD,
    persistent: false,
    // UTF-8 like Supabase. Without this, initdb on Windows picks WIN1252 and the
    // database can't store ₹ or any non-Latin guest name (docs/DECISIONS.md DEC-014).
    initdbFlags: ['--encoding=UTF8', '--locale=C'],
    onLog: () => {},
    onError: (e) => console.error(e),
  });

  console.log('Starting embedded Postgres for the demo...');
  await clearStaleDataDir(dataDir);
  await pg.initialise();
  await pg.start();
  await pg.createDatabase(DEMO_PG_DB);

  const client = pg.getPgClient(DEMO_PG_DB);
  await client.connect();

  console.log('Applying schema migrations...');
  await client.query('create extension if not exists citext');
  await client.query('create extension if not exists pgcrypto');
  for (const file of allMigrationFiles()) {
    await client.query(readFileSync(file, 'utf-8'));
  }

  console.log('Inserting demo fixtures...');
  const lat = demoGateLat();
  const lng = demoGateLng();
  const radiusM = demoGateRadiusM();
  const mediaRoot = path.join(process.cwd(), '.demo-media');
  // DEMO_SEED_AT (ISO instant, optional) seeds visits around another moment instead — the
  // report's screenshot script sets it to the same midday it sets the demo clock to.
  const seedNow = process.env.DEMO_SEED_AT ? Date.parse(process.env.DEMO_SEED_AT) : Date.now();
  if (Number.isNaN(seedNow)) throw new Error('DEMO_SEED_AT must be an ISO date-time');
  const seeded = await seedDemoWorld(client, {
    writeMedia: async (bucket, mediaPath, bytes) => {
      const file = path.join(mediaRoot, bucket, mediaPath);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, bytes);
    },
    gate: {
      code: DEMO_GATE_CODE,
      secret: DEMO_GATE_SECRET,
      dataEncryptionKey: parseDataEncryptionKey(DEMO_DATA_ENCRYPTION_KEY),
      position: { lat, lng },
      radiusM,
    },
    seedNow,
  });

  await client.end();

  console.log('Demo database ready.');
  console.log(`DATABASE_URL=${DEMO_DATABASE_URL}`);
  console.log('');
  console.log(`Residents (dev sign-in): ${DEMO_RESIDENT_1_EMAIL}, ${DEMO_RESIDENT_2_EMAIL}`);
  console.log(
    `Staff (dev sign-in): warden ${DEMO_WARDEN_EMAIL}, office ${DEMO_OFFICE_EMAIL}, super admin ${DEMO_SUPER_ADMIN_EMAIL}`,
  );
  console.log(`Gate coordinates: ${lat}, ${lng} (radius ${radiusM}m)`);
  console.log(
    `Gate pairing code: ${seeded.pairingCode} (expires ${seeded.pairingExpiresAt.toLocaleTimeString()})`,
  );
  console.log('Press Ctrl+C to stop.');

  const stop = () => void stopPostgresSafely(pg, dataDir).finally(() => process.exit(0));
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

void main();
