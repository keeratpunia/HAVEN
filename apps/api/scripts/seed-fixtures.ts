/**
 * The demo world, shared by the laptop demo (`demo-db.ts`, embedded Postgres, photos on
 * disk) and the deployed Phase 1 test version (`staging.ts`, Supabase, photos in
 * Storage) — DEC-026, DEC-028. Dummy people only.
 *
 * - GH-8 with the SDD rules config v1 and one gate.
 * - Two verified residents (rooms 101, 102), a resident waiting for verification, a
 *   warden, an office user and a super admin. Each has an SDD §9.5 test phone, so the
 *   test version's "sign in with a test number" reaches them (`TEST_PHONES`).
 * - Visits and charges relative to `seedNow`, so the dashboards always look current:
 *   three guests inside (one on time, one overstaying, one disputed), one expected
 *   later today, an overnight request for the warden, and yesterday's completed visit.
 *
 * The seeded guests use ordinary-looking numbers (+91 98765 0000x) on purpose: they are
 * history for the dashboards, not accounts anyone signs in to.
 */
import type pg from 'pg';
import sharp from 'sharp';
import { CONSENT_VERSION, GH8_RULES_CONFIG_V1 } from '@haven/shared';
import { encryptAesGcm, sha256 } from '../src/lib/crypto.js';
import { formatPairingCodeForDisplay, generatePairingCode } from '../src/lib/ids.js';

/** SDD §9.5 test numbers given to the seeded users (01–03 stay free for guests). */
export const TEST_PHONES = {
  pendingResident: '+919999900004',
  resident1: '+919999900005',
  resident2: '+919999900006',
  warden: '+919999900007',
  office: '+919999900008',
  superAdmin: '+919999900009',
} as const;

export const SEED_PEOPLE = {
  resident1: { email: 'priya@haven.demo', name: 'Priya Sharma', room: '101' },
  resident2: { email: 'fatima@haven.demo', name: 'Fatima Khan', room: '102' },
  pendingResident: { email: 'neha@haven.demo', name: 'Neha Verma', room: '103' },
  warden: { email: 'warden@haven.demo', name: 'Meera Iyer' },
  office: { email: 'office@haven.demo', name: 'Omar Siddiqui' },
  superAdmin: { email: 'admin@haven.demo', name: 'Dean of Students' },
} as const;

/** The single row an `insert … returning` must give back. */
function one<T extends pg.QueryResultRow>(result: pg.QueryResult<T>): T {
  const row = result.rows[0];
  if (!row) throw new Error('seed: expected a row back from the database');
  return row;
}

// Matches devices.ts's own PAIRING_CODE_TTL_MS (SDD F8 step 1: "8-char code valid 10 min").
const PAIRING_CODE_TTL_MS = 10 * 60_000;

export interface SeedOptions {
  /** Where photos go: local disk for the demo, Supabase Storage for the test version. */
  writeMedia: (
    bucket: 'visitor-photos' | 'resident-docs',
    path: string,
    bytes: Buffer,
  ) => Promise<void>;
  gate: {
    code: string;
    secret: Buffer;
    dataEncryptionKey: Buffer;
    /** null = not set yet: the gate shows GATE_NOT_CONFIGURED until an admin sets it (E-14). */
    position: { lat: number; lng: number } | null;
    radiusM: number;
  };
  /** The instant visits are seeded around (ms since epoch). */
  seedNow: number;
}

export interface SeedResult {
  hostelId: string;
  gateId: string;
  pairingCode: string;
  pairingExpiresAt: Date;
}

export async function seedDemoWorld(client: pg.ClientBase, opts: SeedOptions): Promise<SeedResult> {
  const hostel = await client.query<{ id: string }>(
    `insert into haven.hostels (code, name, gender_served) values ('GH-8', 'Florence Nightingale', 'female')
     on conflict (code) do update set name = excluded.name returning id`,
  );
  const hostelId = one(hostel).id;

  await client.query(
    `insert into haven.hostel_rules (hostel_id, version, config) values ($1, 1, $2::jsonb)
     on conflict (hostel_id, version) do nothing`,
    [hostelId, JSON.stringify(GH8_RULES_CONFIG_V1)],
  );

  const secretEnc = encryptAesGcm(opts.gate.secret, opts.gate.dataEncryptionKey);
  const gate = await client.query<{ id: string }>(
    `insert into haven.gates (hostel_id, code, name, lat, lng, radius_m, secret_enc)
     values ($1, $2, 'Main gate', $3, $4, $5, $6)
     on conflict (code) do update set lat = excluded.lat, lng = excluded.lng, radius_m = excluded.radius_m,
       secret_enc = excluded.secret_enc
     returning id`,
    [
      hostelId,
      opts.gate.code,
      opts.gate.position?.lat ?? null,
      opts.gate.position?.lng ?? null,
      opts.gate.radiusM,
      secretEnc,
    ],
  );
  const gateId = one(gate).id;

  async function upsertUser(email: string, name: string, phone: string) {
    const user = await client.query<{ id: string }>(
      `insert into haven.users (google_sub, email, full_name, phone, phone_verified_at, is_active)
       values ($1, $2, $3, $4, now(), true)
       on conflict (google_sub) do update set full_name = excluded.full_name, phone = excluded.phone
       returning id`,
      [`demo-${email}`, email, name, phone],
    );
    return one(user).id;
  }

  async function upsertVerifiedResident(
    p: { email: string; name: string; room: string },
    phone: string,
  ) {
    const roomRow = await client.query<{ id: string }>(
      `insert into haven.rooms (hostel_id, number) values ($1, $2)
       on conflict (hostel_id, number) do update set number = excluded.number returning id`,
      [hostelId, p.room],
    );
    const userId = await upsertUser(p.email, p.name, phone);
    await client.query(
      `insert into haven.residents (user_id, hostel_id, claimed_room, room_id, status, submitted_at, decided_at)
       values ($1, $2, $3, $4, 'verified', now() - interval '2 days', now() - interval '1 day')
       on conflict (user_id) do update set status = 'verified', room_id = excluded.room_id`,
      [userId, hostelId, p.room, one(roomRow).id],
    );
    return userId;
  }

  const resident1Id = await upsertVerifiedResident(SEED_PEOPLE.resident1, TEST_PHONES.resident1);
  const resident2Id = await upsertVerifiedResident(SEED_PEOPLE.resident2, TEST_PHONES.resident2);

  // ---- Staff (W-01..W-12, O-01) ----
  async function upsertStaff(
    p: { email: string; name: string },
    phone: string,
    role: 'warden' | 'office' | 'super_admin',
  ) {
    const userId = await upsertUser(p.email, p.name, phone);
    await client.query(
      `insert into haven.role_assignments (user_id, hostel_id, role) values ($1, $2, $3)
       on conflict do nothing`,
      [userId, role === 'super_admin' ? null : hostelId, role],
    );
    return userId;
  }
  const wardenId = await upsertStaff(SEED_PEOPLE.warden, TEST_PHONES.warden, 'warden');
  await upsertStaff(SEED_PEOPLE.office, TEST_PHONES.office, 'office');
  await upsertStaff(SEED_PEOPLE.superAdmin, TEST_PHONES.superAdmin, 'super_admin');

  // A resident waiting for verification (W-04), with small generated ID card and selfie
  // images so the warden sees real photos through signed URLs.
  const pendingId = await upsertUser(
    SEED_PEOPLE.pendingResident.email,
    SEED_PEOPLE.pendingResident.name,
    TEST_PHONES.pendingResident,
  );
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
    await opts.writeMedia('resident-docs', mediaPath, bytes);
    const m = await client.query<{ id: string }>(
      `insert into haven.media (kind, bucket, path, sha256, bytes, owner_user_id)
       values ($1, 'resident-docs', $2, $3, $4, $5)
       on conflict (path) do update set deleted_at = null returning id`,
      [kind, mediaPath, sha256(bytes), bytes.length, pendingId],
    );
    docIds.push(one(m).id);
  }
  await client.query(
    `insert into haven.residents (user_id, hostel_id, claimed_room, status, id_card_media_id, selfie_media_id, submitted_at)
     values ($1, $2, $3, 'pending', $4, $5, now() - interval '3 hours')
     on conflict (user_id) do update set status = 'pending'`,
    [pendingId, hostelId, SEED_PEOPLE.pendingResident.room, docIds[0], docIds[1]],
  );

  // ---- Visits for the dashboard, relative to "now" ----
  const at = (minutes: number) => new Date(opts.seedNow + minutes * 60_000).toISOString();
  async function guest(phone: string, name: string) {
    const v = await client.query<{ id: string }>(
      `insert into haven.visitors (phone, full_name, gender, is_adult_confirmed)
       values ($1, $2, 'female', true)
       on conflict (phone) do update set full_name = excluded.full_name returning id`,
      [phone, name],
    );
    return one(v).id;
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
      [one(visit).id, hostelId, gateId, visitorId, at(entered)],
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
      [one(done).id, hostelId, gateId, kind, earlier, at(minutes)],
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

  // A fresh 10-minute pairing code at the real "now" (an admin can always make another
  // from the Gates screen).
  await client.query(`delete from haven.gate_pairing_codes where gate_id = $1`, [gateId]);
  const pairingCode = generatePairingCode();
  const pairingExpiresAt = new Date(Date.now() + PAIRING_CODE_TTL_MS);
  await client.query(
    `insert into haven.gate_pairing_codes (code_hash, gate_id, created_by, expires_at)
     values ($1, $2, $3, $4)`,
    [sha256(pairingCode), gateId, wardenId, pairingExpiresAt.toISOString()],
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
    await opts.writeMedia('visitor-photos', mediaPath, bytes);
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
      [v.id, one(m).id, CONSENT_VERSION],
    );
  }

  return {
    hostelId,
    gateId,
    pairingCode: formatPairingCodeForDisplay(pairingCode),
    pairingExpiresAt,
  };
}
