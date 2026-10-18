#!/usr/bin/env node
/* eslint-disable no-console -- CLI script */
/**
 * Starts one embedded-Postgres instance, applies the real schema migration, and
 * inserts a realistic demo seed: the GH-8 hostel, its real rules config, one gate at
 * configurable coordinates (DEMO_GATE_LAT/DEMO_GATE_LNG — set these to the actual
 * presentation room), two verified residents, and a fresh 10-minute gate pairing
 * code printed to the console so the presentation laptop/phone can pair into the
 * actual gate device via /gate/pair.
 *
 * Demo-only, mirrors e2e-db.ts's embedded-postgres pattern (docs/DECISIONS.md
 * DEC-004/DEC-007/DEC-009) but on its own port/DB name and with the REAL clock in
 * demo-server.ts, not a frozen one — this is meant to be run live, not against a
 * fixed "now". Stays running in the foreground until killed.
 */
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import EmbeddedPostgres from 'embedded-postgres';
import { GH8_RULES_CONFIG_V1 } from '@haven/shared';
import { encryptAesGcm, parseDataEncryptionKey, sha256 } from '../src/lib/crypto.js';
import { generatePairingCode, formatPairingCodeForDisplay } from '../src/lib/ids.js';
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
  DEMO_RESIDENT_1_NAME,
  DEMO_RESIDENT_1_ROOM,
  DEMO_RESIDENT_2_EMAIL,
  DEMO_RESIDENT_2_NAME,
  DEMO_RESIDENT_2_ROOM,
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

// Matches devices.ts's own PAIRING_CODE_TTL_MS (SDD F8 step 1: "8-char code valid 10 min").
const PAIRING_CODE_TTL_MS = 10 * 60_000;

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
  const hostel = await client.query<{ id: string }>(
    `insert into haven.hostels (code, name, gender_served) values ('GH-8', 'Florence Nightingale', 'female')
     on conflict (code) do update set name = excluded.name returning id`,
  );
  const hostelId = hostel.rows[0].id;

  await client.query(
    `insert into haven.hostel_rules (hostel_id, version, config) values ($1, 1, $2::jsonb)
     on conflict (hostel_id, version) do nothing`,
    [hostelId, JSON.stringify(GH8_RULES_CONFIG_V1)],
  );

  const lat = demoGateLat();
  const lng = demoGateLng();
  const radiusM = demoGateRadiusM();
  const dataEncryptionKey = parseDataEncryptionKey(DEMO_DATA_ENCRYPTION_KEY);
  const secretEnc = encryptAesGcm(DEMO_GATE_SECRET, dataEncryptionKey);
  const gate = await client.query<{ id: string }>(
    `insert into haven.gates (hostel_id, code, name, lat, lng, radius_m, secret_enc)
     values ($1, $2, 'Main gate', $3, $4, $5, $6)
     on conflict (code) do update set lat = excluded.lat, lng = excluded.lng, radius_m = excluded.radius_m,
       secret_enc = excluded.secret_enc
     returning id`,
    [hostelId, DEMO_GATE_CODE, lat, lng, radiusM, secretEnc],
  );
  const gateId = gate.rows[0].id;

  async function upsertVerifiedResident(email: string, name: string, room: string) {
    const roomRow = await client.query<{ id: string }>(
      `insert into haven.rooms (hostel_id, number) values ($1, $2)
       on conflict (hostel_id, number) do update set number = excluded.number returning id`,
      [hostelId, room],
    );
    const user = await client.query<{ id: string }>(
      `insert into haven.users (google_sub, email, full_name, phone_verified_at, is_active)
       values ($1, $2, $3, now(), true)
       on conflict (google_sub) do update set full_name = excluded.full_name returning id`,
      [`demo-${email}`, email, name],
    );
    const userId = user.rows[0].id;
    await client.query(
      `insert into haven.residents (user_id, hostel_id, claimed_room, room_id, status, submitted_at, decided_at)
       values ($1, $2, $3, $4, 'verified', now() - interval '2 days', now() - interval '1 day')
       on conflict (user_id) do update set status = 'verified', room_id = excluded.room_id`,
      [userId, hostelId, room, roomRow.rows[0].id],
    );
    return userId;
  }

  const resident1Id = await upsertVerifiedResident(
    DEMO_RESIDENT_1_EMAIL,
    DEMO_RESIDENT_1_NAME,
    DEMO_RESIDENT_1_ROOM,
  );
  await upsertVerifiedResident(DEMO_RESIDENT_2_EMAIL, DEMO_RESIDENT_2_NAME, DEMO_RESIDENT_2_ROOM);

  // Fresh pairing code at REAL "now" (unlike e2e, this script uses the live clock, so
  // the 10-minute TTL must be generated right before printing, not baked into a fixture).
  await client.query(`delete from haven.gate_pairing_codes where gate_id = $1`, [gateId]);
  const pairingCode = generatePairingCode();
  const expiresAt = new Date(Date.now() + PAIRING_CODE_TTL_MS);
  await client.query(
    `insert into haven.gate_pairing_codes (code_hash, gate_id, created_by, expires_at)
     values ($1, $2, $3, $4)`,
    [sha256(pairingCode), gateId, resident1Id, expiresAt.toISOString()],
  );

  await client.end();

  console.log('Demo database ready.');
  console.log(`DATABASE_URL=${DEMO_DATABASE_URL}`);
  console.log('');
  console.log(`Residents (dev sign-in): ${DEMO_RESIDENT_1_EMAIL}, ${DEMO_RESIDENT_2_EMAIL}`);
  console.log(`Gate coordinates: ${lat}, ${lng} (radius ${radiusM}m)`);
  console.log(
    `Gate pairing code: ${formatPairingCodeForDisplay(pairingCode)} (expires ${expiresAt.toLocaleTimeString()})`,
  );
  console.log('Press Ctrl+C to stop.');

  process.on('SIGINT', () => void pg.stop().then(() => process.exit(0)));
  process.on('SIGTERM', () => void pg.stop().then(() => process.exit(0)));
}

void main();
