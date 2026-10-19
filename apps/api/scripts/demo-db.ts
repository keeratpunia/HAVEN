#!/usr/bin/env node
/* eslint-disable no-console -- CLI script */
/**
 * Starts one embedded-Postgres instance, applies the real schema migration, and
 * inserts a realistic demo seed: the GH-8 hostel, its real rules config, one gate at
 * configurable coordinates (DEMO_GATE_LAT/DEMO_GATE_LNG — set these to the actual
 * presentation room), two verified residents, a warden, an office user and a super
 * admin, enough visits and charges to make the warden dashboard meaningful, and a
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
import sharp from 'sharp';
import { CONSENT_VERSION, GH8_RULES_CONFIG_V1 } from '@haven/shared';
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
  DEMO_OFFICE_EMAIL,
  DEMO_OFFICE_NAME,
  DEMO_SUPER_ADMIN_EMAIL,
  DEMO_SUPER_ADMIN_NAME,
  DEMO_WARDEN_EMAIL,
  DEMO_WARDEN_NAME,
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
  const resident2Id = await upsertVerifiedResident(
    DEMO_RESIDENT_2_EMAIL,
    DEMO_RESIDENT_2_NAME,
    DEMO_RESIDENT_2_ROOM,
  );

  // ---- Staff (W-01..W-12, O-01) ----
  async function upsertStaff(
    email: string,
    name: string,
    role: 'warden' | 'office' | 'super_admin',
  ) {
    const user = await client.query<{ id: string }>(
      `insert into haven.users (google_sub, email, full_name, is_active) values ($1, $2, $3, true)
       on conflict (google_sub) do update set full_name = excluded.full_name returning id`,
      [`demo-${email}`, email, name],
    );
    await client.query(
      `insert into haven.role_assignments (user_id, hostel_id, role) values ($1, $2, $3)
       on conflict do nothing`,
      [user.rows[0].id, role === 'super_admin' ? null : hostelId, role],
    );
    return user.rows[0].id;
  }
  const wardenId = await upsertStaff(DEMO_WARDEN_EMAIL, DEMO_WARDEN_NAME, 'warden');
  await upsertStaff(DEMO_OFFICE_EMAIL, DEMO_OFFICE_NAME, 'office');
  await upsertStaff(DEMO_SUPER_ADMIN_EMAIL, DEMO_SUPER_ADMIN_NAME, 'super_admin');

  // A resident waiting for verification (W-04), with small generated ID card and selfie
  // images so the warden sees real photos through signed URLs.
  const mediaRoot = path.join(process.cwd(), '.demo-media');
  const pending = await client.query<{ id: string }>(
    `insert into haven.users (google_sub, email, full_name, phone, phone_verified_at, is_active)
     values ('demo-neha@haven.demo', 'neha@haven.demo', 'Neha Verma', '+919999911103', now(), true)
     on conflict (google_sub) do update set full_name = excluded.full_name returning id`,
  );
  const pendingId = pending.rows[0].id;
  const docIds: string[] = [];
  for (const [kind, shade] of [
    ['resident_id_card', 120],
    ['resident_selfie', 200],
  ] as const) {
    const bytes = await sharp({
      create: { width: 320, height: 200, channels: 3, background: { r: shade, g: 110, b: 90 } },
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
     values ($1, $2, '103', 'pending', $3, $4, now() - interval '3 hours')
     on conflict (user_id) do update set status = 'pending'`,
    [pendingId, hostelId, docIds[0], docIds[1]],
  );

  // ---- Visits for the dashboard, relative to the real "now" ----
  const at = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString();
  async function guest(phone: string, name: string) {
    const v = await client.query<{ id: string }>(
      `insert into haven.visitors (phone, full_name, gender, is_adult_confirmed)
       values ($1, $2, 'female', true)
       on conflict (phone) do update set full_name = excluded.full_name returning id`,
      [phone, name],
    );
    return v.rows[0].id;
  }
  async function insideVisit(
    code: string,
    hostId: string,
    visitorId: string,
    window: [number, number],
    entered: number,
    extra: { overstaySince?: number; disputedAt?: number } = {},
  ) {
    const visit = await client.query<{ id: string }>(
      `insert into haven.visits
         (code, hostel_id, host_id, visitor_id, type, status, origin, zone, window_start, window_end,
          rules_version, created_by_type, created_by_id, first_entry_at, last_entry_at,
          host_confirmed_at, overstay_since, host_disputed_at)
       values ($1, $2, $3, $4, 'day', 'inside', 'invite', 'visitors_room', $5, $6, 1, 'user', $3, $7, $7,
               $8, $9, $10)
       returning id`,
      [
        code,
        hostelId,
        hostId,
        visitorId,
        at(window[0]),
        at(window[1]),
        at(entered),
        extra.disputedAt === undefined ? at(entered + 1) : null,
        extra.overstaySince === undefined ? null : at(extra.overstaySince),
        extra.disputedAt === undefined ? null : at(extra.disputedAt),
      ],
    );
    await client.query(
      `insert into haven.gate_events
         (visit_id, hostel_id, gate_id, kind, actor_type, actor_id, location_verified, distance_m, accuracy_m, at)
       values ($1, $2, $3, 'entry', 'visitor', $4, true, 12, 9, $5)`,
      [visit.rows[0].id, hostelId, gateId, visitorId, at(entered)],
    );
  }
  // Inside, on time.
  await insideVisit(
    'VDEM001',
    resident1Id,
    await guest('+919876500001', 'Ananya Rao'),
    [-60, 180],
    -50,
  );
  // Inside past the window: the overstay job (SDD §9.8) has flagged it.
  await insideVisit(
    'VDEM002',
    resident2Id,
    await guest('+919876500002', 'Kavya Menon'),
    [-300, -30],
    -280,
    {
      overstaySince: -20,
    },
  );
  // Inside, but the host said "Not my guest" (F9): waits for the warden.
  await insideVisit(
    'VDEM003',
    resident2Id,
    await guest('+919876500003', 'Riya Das'),
    [-90, 120],
    -15,
    {
      disputedAt: -10,
    },
  );
  // Expected later today (an invite not yet claimed).
  await client.query(
    `insert into haven.visits
       (code, hostel_id, host_id, invited_name, invited_phone, invited_gender, type, status, origin, zone,
        window_start, window_end, rules_version, created_by_type, created_by_id)
     values ('VDEM004', $1, $2, 'Sneha Pillai', '+919876500004', 'female', 'day', 'approved', 'invite',
             'visitors_room', $3, $4, 1, 'user', $2)`,
    [hostelId, resident1Id, at(60), at(240)],
  );
  // An overnight stay waiting for the warden (F6 step 4).
  await client.query(
    `insert into haven.visits
       (code, hostel_id, host_id, invited_name, invited_phone, invited_gender, type, status, origin, zone,
        window_start, window_end, nights, rules_version, created_by_type, created_by_id)
     values ('VDEM005', $1, $2, 'Meghna Joshi', '+919876500005', 'female', 'overnight_room', 'pending_warden',
             'overnight_request', 'room', $3, $4, 2, 1, 'user', $2)`,
    [hostelId, resident1Id, at(24 * 60), at(72 * 60)],
  );
  // Yesterday's visit, checked out (shows in reports and search).
  const earlier = await guest('+919876500006', 'Divya Nair');
  const done = await client.query<{ id: string }>(
    `insert into haven.visits
       (code, hostel_id, host_id, visitor_id, type, status, origin, zone, window_start, window_end,
        rules_version, created_by_type, created_by_id, first_entry_at, last_entry_at, last_exit_at,
        host_confirmed_at, closed_at, close_reason)
     values ('VDEM006', $1, $2, $3, 'day', 'completed', 'invite', 'visitors_room', $4, $5, 1, 'user', $2,
             $6, $6, $7, $6, $7, 'checked_out')
     returning id`,
    [hostelId, resident1Id, earlier, at(-26 * 60), at(-22 * 60), at(-25 * 60), at(-23 * 60)],
  );
  for (const [kind, minutes] of [
    ['entry', -25 * 60],
    ['exit', -23 * 60],
  ] as const) {
    await client.query(
      `insert into haven.gate_events
         (visit_id, hostel_id, gate_id, kind, actor_type, actor_id, location_verified, distance_m, accuracy_m, at)
       values ($1, $2, $3, $4, 'visitor', $5, true, 15, 10, $6)`,
      [done.rows[0].id, hostelId, gateId, kind, earlier, at(minutes)],
    );
  }

  // ---- Charges for the office (O-01) ----
  await client.query(
    `insert into haven.charges
       (hostel_id, resident_id, kind, units, unit_price_inr, amount_inr, description, status, created_by, created_at)
     values ($1, $2, 'overnight_room', 2, 50, 100, 'Overnight room stay, 2 night(s).', 'pending', $3,
             now() - interval '2 days')`,
    [hostelId, resident2Id, wardenId],
  );
  await client.query(
    `insert into haven.charges
       (hostel_id, resident_id, kind, amount_inr, description, status, created_by, created_at, confirmed_by, confirmed_at)
     values ($1, $2, 'fine', 400, 'Guest stayed past the 10 pm cutoff.', 'confirmed', $3, now() - interval '5 days',
             $3, now() - interval '4 days')`,
    [hostelId, resident1Id, wardenId],
  );

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

  // FR-02 / §12.2: a guest needs a finished profile (name, 18+, consent, profile photo)
  // before the API lets them claim, check in or walk in. Seeded guests stand in for
  // people who already did G-04/G-05.
  const unfinished = await client.query<{ id: string }>(
    `select id from haven.visitors where created_by_host_id is null and profile_media_id is null`,
  );
  for (const [i, v] of unfinished.rows.entries()) {
    const bytes = await sharp({
      create: {
        width: 96,
        height: 96,
        channels: 3,
        background: { r: 40 + i * 20, g: 140, b: 180 },
      },
    })
      .jpeg()
      .toBuffer();
    const mediaPath = `${v.id}/profile.jpg`;
    mkdirSync(path.dirname(path.join(mediaRoot, 'visitor-photos', mediaPath)), { recursive: true });
    writeFileSync(path.join(mediaRoot, 'visitor-photos', mediaPath), bytes);
    const m = await client.query<{ id: string }>(
      `insert into haven.media (kind, bucket, path, sha256, bytes, owner_visitor_id)
       values ('visitor_profile', 'visitor-photos', $1, $2, $3, $4)
       on conflict (path) do update set deleted_at = null returning id`,
      [mediaPath, sha256(bytes), bytes.length, v.id],
    );
    await client.query(
      `update haven.visitors
          set profile_media_id = $2, is_adult_confirmed = true, consent_version = $3, consent_at = now()
        where id = $1`,
      [v.id, m.rows[0].id, CONSENT_VERSION],
    );
  }

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
    `Gate pairing code: ${formatPairingCodeForDisplay(pairingCode)} (expires ${expiresAt.toLocaleTimeString()})`,
  );
  console.log('Press Ctrl+C to stop.');

  process.on('SIGINT', () => void pg.stop().then(() => process.exit(0)));
  process.on('SIGTERM', () => void pg.stop().then(() => process.exit(0)));
}

void main();
