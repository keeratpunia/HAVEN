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
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import EmbeddedPostgres from 'embedded-postgres';
import sharp from 'sharp';
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

  // ---- Warden and office specs (apps/mobile/e2e/tests/warden-office.spec.ts) ----
  const staffUser = async (sub: string, email: string, name: string, role: 'warden' | 'office') => {
    const u = await client.query<{ id: string }>(
      `insert into haven.users (google_sub, email, full_name, is_active) values ($1, $2, $3, true)
       on conflict (google_sub) do update set full_name = excluded.full_name returning id`,
      [sub, email, name],
    );
    await client.query(
      `insert into haven.role_assignments (user_id, hostel_id, role) values ($1, $2, $3)
       on conflict do nothing`,
      [u.rows[0].id, hostelId, role],
    );
  };
  await staffUser('e2e-warden', 'e2e-warden@haven.test', 'Meera Warden', 'warden');
  await staffUser('e2e-office', 'e2e-office@haven.test', 'Omar Office', 'office');

  // A resident waiting for verification, with real (tiny) ID card and selfie files so
  // W-04 can show the photos through signed URLs.
  const mediaRoot = path.join(process.cwd(), '.e2e-media');
  const pendingUser = await client.query<{ id: string }>(
    `insert into haven.users (google_sub, email, full_name, phone, phone_verified_at, is_active)
     values ('e2e-pending', 'e2e-pending@haven.test', 'Kiran Pending', '+919999911102', now(), true)
     on conflict (google_sub) do update set full_name = excluded.full_name returning id`,
  );
  const pendingId = pendingUser.rows[0].id;
  const docIds: string[] = [];
  for (const [kind, shade] of [
    ['resident_id_card', 120],
    ['resident_selfie', 200],
  ] as const) {
    const bytes = await sharp({
      create: { width: 64, height: 64, channels: 3, background: { r: shade, g: 90, b: 60 } },
    })
      .jpeg()
      .toBuffer();
    const mediaPath = `${pendingId}/${kind.replace(/_/g, '-')}.jpg`;
    mkdirSync(path.dirname(path.join(mediaRoot, 'resident-docs', mediaPath)), { recursive: true });
    writeFileSync(path.join(mediaRoot, 'resident-docs', mediaPath), bytes);
    const m = await client.query<{ id: string }>(
      `insert into haven.media (kind, bucket, path, sha256, bytes, owner_user_id)
       values ($1, 'resident-docs', $2, $3, $4, $5)
       on conflict (path) do update set deleted_at = null returning id`,
      [kind, mediaPath, sha256(bytes), bytes.length, pendingId],
    );
    docIds.push(m.rows[0].id);
  }
  await client.query(
    `insert into haven.residents (user_id, hostel_id, claimed_room, status, id_card_media_id, selfie_media_id, submitted_at)
     values ($1, $2, '102', 'pending', $3, $4, now())
     on conflict (user_id) do update set status = 'pending', id_card_media_id = excluded.id_card_media_id`,
    [pendingId, hostelId, docIds[0], docIds[1]],
  );

  // An overnight request waiting for the warden (F6 step 4), host Priya.
  await client.query(`delete from haven.visits where code in ('VE2E004','VE2E005','VE2E006')`);
  const arrival = new Date(E2E_FIXED_NOW.getTime() + 2 * 86_400_000);
  arrival.setUTCHours(2, 30, 0, 0); // 08:00 IST
  const departure = new Date(arrival.getTime() + 2 * 86_400_000 + 4 * 3_600_000); // 12:00 IST, 2 nights
  await client.query(
    `insert into haven.visits
       (code, hostel_id, host_id, invited_name, invited_phone, invited_gender, type, status, origin, zone,
        window_start, window_end, nights, rules_version, created_by_type, created_by_id)
     values ('VE2E004', $1, $2, 'Overnight Cousin', '+919812300099', 'female', 'overnight_room', 'pending_warden',
             'overnight_request', 'room', $3, $4, 2, 1, 'user', $2)`,
    [hostelId, hostId, arrival.toISOString(), departure.toISOString()],
  );

  // A guest inside right now (to force check-out and ban), signing in as ...05 later.
  const banGuest = await client.query<{ id: string }>(
    `insert into haven.visitors (phone, full_name, gender, is_adult_confirmed)
     values ('+919999900005', 'Ban Tester', 'female', true)
     on conflict (phone) do update set full_name = excluded.full_name returning id`,
  );
  await client.query(
    `insert into haven.visits
       (code, hostel_id, host_id, visitor_id, type, status, origin, zone,
        window_start, window_end, rules_version, created_by_type, created_by_id, first_entry_at, last_entry_at)
     values ('VE2E005', $1, $2, $3, 'day', 'inside', 'invite', 'visitors_room', $4, $5, 1, 'user', $2, $4, $4)`,
    [hostelId, hostId, banGuest.rows[0].id, windowStart.toISOString(), windowEnd.toISOString()],
  );

  // A guest with an approved visit who checks in while the warden watches (SSE), as ...04.
  const liveGuest = await client.query<{ id: string }>(
    `insert into haven.visitors (phone, full_name, gender, is_adult_confirmed)
     values ('+919999900004', 'Live Tester', 'female', true)
     on conflict (phone) do update set full_name = excluded.full_name returning id`,
  );
  await client.query(
    `insert into haven.visits
       (code, hostel_id, host_id, visitor_id, type, status, origin, zone,
        window_start, window_end, rules_version, created_by_type, created_by_id)
     values ('VE2E006', $1, $2, $3, 'day', 'approved', 'invite', 'visitors_room', $4, $5, 1, 'user', $2)`,
    [hostelId, hostId, liveGuest.rows[0].id, windowStart.toISOString(), windowEnd.toISOString()],
  );

  // ---- Account deletion (apps/mobile/e2e/tests/account-deletion.spec.ts, FR-09) ----
  // A guest with a finished visit, signing in as ...06 (otherwise only used as a
  // resident's phone in R-02, so this second OTP request stays inside the limit).
  const leavingGuest = await client.query<{ id: string }>(
    `insert into haven.visitors (phone, full_name, gender, is_adult_confirmed, consent_version, consent_at)
     values ('+919999900006', 'Delete Tester', 'female', true, 'v1', now())
     on conflict (phone) do update set full_name = excluded.full_name returning id`,
  );
  await client.query(`delete from haven.visits where code = 'VE2E007'`);
  await client.query(
    `insert into haven.visits
       (code, hostel_id, host_id, visitor_id, type, status, origin, zone, window_start, window_end,
        rules_version, created_by_type, created_by_id, first_entry_at, last_entry_at, last_exit_at,
        closed_at, close_reason)
     values ('VE2E007', $1, $2, $3, 'day', 'completed', 'invite', 'visitors_room', $4, $5, 1, 'user', $2,
             $4, $4, $5, $5, 'checked_out')`,
    [
      hostelId,
      hostId,
      leavingGuest.rows[0].id,
      new Date(E2E_FIXED_NOW.getTime() - 26 * 3_600_000).toISOString(),
      new Date(E2E_FIXED_NOW.getTime() - 24 * 3_600_000).toISOString(),
    ],
  );
  // Two residents: one who owes a fine (blocked, §16.6 step 4) and one who doesn't.
  for (const [sub, email, name, room, phone, owes] of [
    ['e2e-owes', 'e2e-owes@haven.test', 'Owes Fine', '103', '+919999911103', true],
    ['e2e-leaving', 'e2e-leaving@haven.test', 'Leaving Resident', '104', '+919999911104', false],
  ] as const) {
    const roomRow = await client.query<{ id: string }>(
      `insert into haven.rooms (hostel_id, number) values ($1, $2)
       on conflict (hostel_id, number) do update set number = excluded.number returning id`,
      [hostelId, room],
    );
    const u = await client.query<{ id: string }>(
      `insert into haven.users (google_sub, email, full_name, phone, phone_verified_at, is_active)
       values ($1, $2, $3, $4, now(), true)
       on conflict (google_sub) do update set full_name = excluded.full_name returning id`,
      [sub, email, name, phone],
    );
    await client.query(
      `insert into haven.residents (user_id, hostel_id, claimed_room, room_id, status, submitted_at, decided_at)
       values ($1, $2, $3, $4, 'verified', now() - interval '2 days', now() - interval '1 day')
       on conflict (user_id) do update set status = 'verified'`,
      [u.rows[0].id, hostelId, room, roomRow.rows[0].id],
    );
    if (owes) {
      await client.query(
        `insert into haven.charges (hostel_id, resident_id, kind, amount_inr, description, status)
         values ($1, $2, 'fine', 400, 'Guest stayed past the 10 pm cutoff.', 'confirmed')`,
        [hostelId, u.rows[0].id],
      );
    }
  }

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
