#!/usr/bin/env node
/* eslint-disable no-console -- CLI script */
/**
 * Starts one embedded-Postgres instance, applies the real schema migration, and
 * inserts the minimal fixture data the guest-web Playwright E2E suite needs: a
 * hostel, a gate with real coordinates (so the check-in geofence check genuinely
 * passes against Playwright's mocked geolocation), a verified resident host, and one
 * `approved` pre-invite visit reachable at a known invite token.
 *
 * Dev/E2E-only (same `embedded-postgres` substitute for Docker as the test suites —
 * see docs/DECISIONS.md DEC-004/DEC-007/DEC-009). Stays running in the foreground
 * until killed; prints the DATABASE_URL to use.
 */
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import EmbeddedPostgres from 'embedded-postgres';
import { encryptAesGcm, parseDataEncryptionKey, sha256 } from '../src/lib/crypto.js';
import {
  E2E_DATABASE_URL,
  E2E_DATA_ENCRYPTION_KEY,
  E2E_FIXED_NOW,
  E2E_GATE_CODE,
  E2E_GATE_LAT,
  E2E_GATE_LNG,
  E2E_GATE_RADIUS_M,
  E2E_GATE_SECRET,
  E2E_INVITE_TOKEN,
  E2E_PG_DB,
  E2E_PG_PASSWORD,
  E2E_PG_PORT,
  E2E_PG_USER,
} from './e2e-constants.js';

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
  const dataDir = path.join(process.cwd(), '.e2e-pgdata');
  const pg = new EmbeddedPostgres({
    databaseDir: dataDir,
    port: E2E_PG_PORT,
    user: E2E_PG_USER,
    password: E2E_PG_PASSWORD,
    persistent: false,
    // UTF-8 like Supabase. Without this, initdb on Windows picks WIN1252 and the
    // database can't store ₹ or any non-Latin guest name (docs/DECISIONS.md DEC-014).
    initdbFlags: ['--encoding=UTF8', '--locale=C'],
    onLog: () => {},
    onError: (e) => console.error(e),
  });

  console.log('Starting embedded Postgres for E2E...');
  await pg.initialise();
  await pg.start();
  await pg.createDatabase(E2E_PG_DB);

  const client = pg.getPgClient(E2E_PG_DB);
  await client.connect();

  console.log('Applying schema migration...');
  await client.query('create extension if not exists citext');
  await client.query('create extension if not exists pgcrypto');
  for (const file of allMigrationFiles()) {
    await client.query(readFileSync(file, 'utf-8'));
  }

  console.log('Inserting E2E fixtures...');
  const hostel = await client.query<{ id: string }>(
    `insert into haven.hostels (code, name, gender_served) values ('GH-8', 'Florence Nightingale', 'female')
     on conflict (code) do update set name = excluded.name returning id`,
  );
  const hostelId = hostel.rows[0].id;

  await client.query(
    `insert into haven.hostel_rules (hostel_id, version, config) values ($1, 1, $2::jsonb)
     on conflict (hostel_id, version) do nothing`,
    [
      hostelId,
      JSON.stringify({
        timezone: 'Asia/Kolkata',
        hostel_gender: 'female',
        visiting_start: '08:00',
        last_entry_day: '20:00',
        hard_cutoff: '22:00',
        day_visit_latest_end: '22:00',
        overnight_checkout_time: '12:00',
        early_arrival_minutes: 30,
        overstay_grace_minutes: 15,
        quick_drop_minutes: 15,
        walk_in_timeout_minutes: 10,
        dispute_window_minutes: 30,
        max_active_day_guests: 3,
        invite_max_days_ahead: 7,
        overnight_max_days_ahead: 30,
        overnight_room: {
          enabled: true,
          max_nights_per_month: 3,
          max_concurrent: 1,
          charge_per_night_inr: 50,
        },
        guest_room: { enabled: true, charge_per_night_inr: 150 },
        opposite_gender: { zone: 'visitors_room', allow_overnight: false },
        undisclosed_gender_as_opposite: true,
        min_manual_fine_inr: 400,
        night_sweep_time: '22:00',
      }),
    ],
  );

  const dataEncryptionKey = parseDataEncryptionKey(E2E_DATA_ENCRYPTION_KEY);
  const secretEnc = encryptAesGcm(E2E_GATE_SECRET, dataEncryptionKey);
  const gate = await client.query<{ id: string }>(
    `insert into haven.gates (hostel_id, code, name, lat, lng, radius_m, secret_enc)
     values ($1, $2, 'Main gate', $3, $4, $5, $6)
     on conflict (code) do update set lat = excluded.lat, lng = excluded.lng, radius_m = excluded.radius_m,
       secret_enc = excluded.secret_enc
     returning id`,
    [hostelId, E2E_GATE_CODE, E2E_GATE_LAT, E2E_GATE_LNG, E2E_GATE_RADIUS_M, secretEnc],
  );
  void gate;

  const room = await client.query<{ id: string }>(
    `insert into haven.rooms (hostel_id, number) values ($1, '101')
     on conflict (hostel_id, number) do update set number = excluded.number returning id`,
    [hostelId],
  );

  const host = await client.query<{ id: string }>(
    `insert into haven.users (google_sub, email, full_name, phone, phone_verified_at, is_active)
     values ('e2e-host', 'e2e-host@haven.test', 'Priya Sharma', '+919999911101', now(), true)
     on conflict (google_sub) do update set full_name = excluded.full_name returning id`,
  );
  const hostId = host.rows[0].id;

  await client.query(
    `insert into haven.residents (user_id, hostel_id, claimed_room, room_id, status, submitted_at, decided_at)
     values ($1, $2, '101', $3, 'verified', now() - interval '2 days', now() - interval '1 day')
     on conflict (user_id) do update set status = 'verified', room_id = excluded.room_id`,
    [hostId, hostelId, room.rows[0].id],
  );

  const windowStart = new Date(E2E_FIXED_NOW.getTime() - 60 * 60 * 1000);
  const windowEnd = new Date(E2E_FIXED_NOW.getTime() + 4 * 60 * 60 * 1000);
  await client.query(`delete from haven.visits where code = 'VE2E001'`);
  // invited_phone MUST be one of the non-production OTP-bypass numbers
  // (+919999900001-09, SDD §9.5) — the Playwright suite signs in as that exact phone
  // and claims this invite, which requires signed-in phone === invited_phone.
  await client.query(
    `insert into haven.visits
       (code, hostel_id, host_id, invited_name, invited_phone, invited_gender, type, status, origin, zone,
        window_start, window_end, rules_version, invite_token_hash, created_by_type, created_by_id)
     values ('VE2E001', $1, $2, 'E2E Guest', '+919999900009', 'female', 'day', 'approved', 'invite', 'visitors_room',
             $3, $4, 1, $5, 'user', $2)`,
    [
      hostelId,
      hostId,
      windowStart.toISOString(),
      windowEnd.toISOString(),
      sha256(E2E_INVITE_TOKEN),
    ],
  );

  // A second, pre-claimed guest (phone ...08, distinct from the golden-path test's
  // ...09) with an already-complete profile and its own approved visit — so the
  // location-retry/"Ask host to confirm" test can reach a real check-in/awaiting-
  // confirmation outcome without racing the golden-path test's state for phone ...09.
  const retryVisitor = await client.query<{ id: string }>(
    `insert into haven.visitors (phone, full_name, gender, is_adult_confirmed)
     values ('+919999900008', 'Retry Tester', 'female', true)
     on conflict (phone) do update set full_name = excluded.full_name returning id`,
  );
  await client.query(`delete from haven.visits where code = 'VE2E002'`);
  await client.query(
    `insert into haven.visits
       (code, hostel_id, host_id, visitor_id, type, status, origin, zone,
        window_start, window_end, rules_version, created_by_type, created_by_id)
     values ('VE2E002', $1, $2, $3, 'day', 'approved', 'invite', 'visitors_room', $4, $5, 1, 'user', $2)`,
    [hostelId, hostId, retryVisitor.rows[0].id, windowStart.toISOString(), windowEnd.toISOString()],
  );

  // Resident-app specs: a third pre-claimed guest (phone ...07) whose check-in drives
  // the host's arrival card (R-09) and dispute, and a Google user who hasn't onboarded
  // yet (no phone, no resident row) for the R-02 → R-03 → R-04 flow.
  const arrivalVisitor = await client.query<{ id: string }>(
    `insert into haven.visitors (phone, full_name, gender, is_adult_confirmed)
     values ('+919999900007', 'Arrival Tester', 'female', true)
     on conflict (phone) do update set full_name = excluded.full_name returning id`,
  );
  await client.query(`delete from haven.visits where code = 'VE2E003'`);
  await client.query(
    `insert into haven.visits
       (code, hostel_id, host_id, visitor_id, type, status, origin, zone,
        window_start, window_end, rules_version, created_by_type, created_by_id)
     values ('VE2E003', $1, $2, $3, 'day', 'approved', 'invite', 'visitors_room', $4, $5, 1, 'user', $2)`,
    [
      hostelId,
      hostId,
      arrivalVisitor.rows[0].id,
      windowStart.toISOString(),
      windowEnd.toISOString(),
    ],
  );
  await client.query(
    `insert into haven.users (google_sub, email, full_name, is_active)
     values ('e2e-newcomer', 'e2e-newcomer@haven.test', 'Neha Gill', true)
     on conflict (google_sub) do nothing`,
  );

  await client.end();

  console.log('E2E database ready.');
  console.log(`DATABASE_URL=${E2E_DATABASE_URL}`);
  console.log(`Invite link token: ${E2E_INVITE_TOKEN}`);
  console.log(`Gate code: ${E2E_GATE_CODE}`);
  console.log('Press Ctrl+C to stop.');

  process.on('SIGINT', () => void pg.stop().then(() => process.exit(0)));
  process.on('SIGTERM', () => void pg.stop().then(() => process.exit(0)));
}

void main();
