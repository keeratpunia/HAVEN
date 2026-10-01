#!/usr/bin/env node
/* eslint-disable no-console -- this is a CLI script; console output is its whole UX, not application logging */
/**
 * HAVEN seed script (SDD §11.9, §12.1 seed table).
 *
 * "Seeding is a TypeScript script (`pnpm --filter api seed`) because gate secrets must
 * be encrypted with the app key. It is idempotent (upserts on natural keys)."
 *
 * Scope of this script, exactly per the SDD's seed table:
 *   All environments:
 *     - Hostel GH-8 (Florence Nightingale, female)
 *     - Gate GH8A01 "Main gate" (location unset)
 *     - Rules v1 from SDD §4.3
 *     - A pre-accepted-on-first-sign-in staff_invites row for SEED_SUPER_ADMIN_EMAIL
 *       (super_admin) and SEED_WARDEN_EMAIL (warden)
 *   Local and staging only:
 *     - Rooms 101-110 and 201-210
 *     - 10 fake verified residents
 *     - 15 fake visitors on test phones +9199999000xx
 *     - 30 visits covering every status and flag
 *     - One paired fake gate device
 *     - Generated placeholder photos (media rows only — no real files; actual Storage
 *       upload is API/media-module work, out of scope for the database-foundation
 *       milestone this script belongs to)
 *
 * This script does NOT implement any business logic (no rules engine, no state
 * machine) — every row it writes is inserted directly with an explicit, valid status,
 * exactly as fixture data. Business logic is implemented by the API in later
 * milestones (docs/IMPLEMENTATION-PLAN.md M1+).
 */
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { z } from 'zod';
import { encryptAesGcm, parseDataEncryptionKey, randomSecret, sha256 } from '../src/lib/crypto.js';

const SeedEnvSchema = z.object({
  APP_ENV: z.enum(['local', 'staging', 'production']).default('local'),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  DATA_ENCRYPTION_KEY: z.string().min(1, 'DATA_ENCRYPTION_KEY is required'),
  SEED_SUPER_ADMIN_EMAIL: z.string().email('SEED_SUPER_ADMIN_EMAIL must be a valid email'),
  SEED_WARDEN_EMAIL: z.string().email('SEED_WARDEN_EMAIL must be a valid email'),
});

// GH-8 rules config v1, transcribed verbatim from SDD §4.3. Do not hand-edit values
// here — if the SDD's config changes, this must change in the same PR (CLAUDE.md §1.3).
const RULES_V1 = {
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
};

async function main() {
  const env = SeedEnvSchema.parse(process.env);
  const client = new pg.Client({ connectionString: env.DATABASE_URL });
  await client.connect();

  try {
    await client.query('begin');

    console.log('Seeding hostel, gate, rules, and staff invites (all environments)...');
    const hostelId = await seedHostel(client);
    await seedRulesV1(client, hostelId);
    await seedGate(client, hostelId, env.DATA_ENCRYPTION_KEY);
    await seedStaffInvites(client, hostelId, env.SEED_SUPER_ADMIN_EMAIL, env.SEED_WARDEN_EMAIL);

    if (env.APP_ENV !== 'production') {
      console.log('Seeding local/staging-only fake data...');
      const fakeWardenId = await seedFakeWardenActor(client);
      const roomIds = await seedRooms(client, hostelId);
      const residentIds = await seedResidents(client, hostelId, roomIds, fakeWardenId);
      const visitorIds = await seedVisitors(client);
      await seedGateDevice(client, hostelId, fakeWardenId);
      await seedVisits(client, hostelId, residentIds, visitorIds);
    } else {
      console.log('APP_ENV=production: skipping fake rooms/residents/visitors/visits/device.');
    }

    await client.query('commit');
    console.log('Seed complete.');
  } catch (err) {
    await client.query('rollback');
    throw err;
  } finally {
    await client.end();
  }
}

async function seedHostel(client: pg.Client): Promise<string> {
  const res = await client.query<{ id: string }>(
    `insert into haven.hostels (code, name, gender_served)
     values ('GH-8', 'Florence Nightingale', 'female')
     on conflict (code) do update set name = excluded.name
     returning id`,
  );
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- RETURNING on an upsert always returns exactly one row
  return res.rows[0]!.id;
}

async function seedRulesV1(client: pg.Client, hostelId: string): Promise<void> {
  await client.query(
    `insert into haven.hostel_rules (hostel_id, version, config)
     values ($1, 1, $2::jsonb)
     on conflict (hostel_id, version) do nothing`,
    [hostelId, JSON.stringify(RULES_V1)],
  );
}

async function seedGate(
  client: pg.Client,
  hostelId: string,
  dataEncryptionKeyB64: string,
): Promise<string> {
  const key = parseDataEncryptionKey(dataEncryptionKeyB64);
  const secretEnc = encryptAesGcm(randomSecret(32), key);
  const res = await client.query<{ id: string }>(
    `insert into haven.gates (hostel_id, code, name, secret_enc)
     values ($1, 'GH8A01', 'Main gate', $2)
     on conflict (code) do nothing
     returning id`,
    [hostelId, secretEnc],
  );
  if (res.rows.length > 0) {
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- checked rows.length > 0 above
    return res.rows[0]!.id;
  }
  const existing = await client.query<{ id: string }>(
    `select id from haven.gates where code = 'GH8A01'`,
  );
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- the gate was either just inserted or already exists; one of the two queries always returns a row
  return existing.rows[0]!.id;
}

async function seedStaffInvites(
  client: pg.Client,
  hostelId: string,
  superAdminEmail: string,
  wardenEmail: string,
): Promise<void> {
  // 10 years out: these seed invites are not expected to expire in practice during the
  // prototype's lifetime (see docs/DECISIONS.md — the SDD specifies "48h expiry bound
  // to the invited email" for invites a *warden* sends via FR-06, but is silent on the
  // expiry for the two seed-created invites specifically, which have no inviter to
  // resend them).
  const farFuture = new Date();
  farFuture.setFullYear(farFuture.getFullYear() + 10);

  await upsertStaffInvite(client, null, 'super_admin', superAdminEmail, farFuture);
  await upsertStaffInvite(client, hostelId, 'warden', wardenEmail, farFuture);
}

async function upsertStaffInvite(
  client: pg.Client,
  hostelId: string | null,
  role: 'super_admin' | 'warden',
  email: string,
  expiresAt: Date,
): Promise<void> {
  const exists = await client.query(
    `select 1 from haven.staff_invites where email = $1 and role = $2 and accepted_at is null`,
    [email, role],
  );
  if (exists.rows.length > 0) return;
  const tokenHash = sha256(randomUUID());
  await client.query(
    `insert into haven.staff_invites (hostel_id, role, email, token_hash, invited_by, expires_at)
     values ($1, $2, $3, $4, null, $5)`,
    [hostelId, role, email, tokenHash, expiresAt.toISOString()],
  );
}

/**
 * A local/staging-only fake "warden" user, used only to satisfy FK constraints on
 * fake data (residents.decided_by, gate_devices.paired_by, etc.) that require a real
 * `users` row. This is distinct from the real SEED_WARDEN_EMAIL staff invite above,
 * which is unaccepted until an actual person signs in with Google — the auth flow
 * that does that acceptance isn't built until M1, so there is no real warden `users`
 * row yet. Documented in docs/DECISIONS.md.
 */
async function seedFakeWardenActor(client: pg.Client): Promise<string> {
  const res = await client.query<{ id: string }>(
    `insert into haven.users (google_sub, email, full_name, phone, phone_verified_at, is_active)
     values ('seed-fake-warden', 'seed-fake-warden@haven.test', 'Seed Warden', '+919999900099', now(), true)
     on conflict (google_sub) do update set full_name = excluded.full_name
     returning id`,
  );
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- RETURNING on an upsert always returns exactly one row
  return res.rows[0]!.id;
}

async function seedRooms(client: pg.Client, hostelId: string): Promise<string[]> {
  const numbers = [
    ...Array.from({ length: 10 }, (_, i) => String(101 + i)),
    ...Array.from({ length: 10 }, (_, i) => String(201 + i)),
  ];
  const ids: string[] = [];
  for (const number of numbers) {
    const res = await client.query<{ id: string }>(
      `insert into haven.rooms (hostel_id, number)
       values ($1, $2)
       on conflict (hostel_id, number) do update set number = excluded.number
       returning id`,
      [hostelId, number],
    );
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- RETURNING on an upsert always returns exactly one row
    ids.push(res.rows[0]!.id);
  }
  return ids;
}

async function seedResidents(
  client: pg.Client,
  hostelId: string,
  roomIds: string[],
  decidedBy: string,
): Promise<string[]> {
  const residentIds: string[] = [];
  // One verified resident per room 101-110 (the first 10 of the 20 seeded rooms);
  // 201-210 are left unoccupied so walk-in "no registered resident in this room"
  // (SDD G-08 empty state) has something real to test against.
  for (let i = 0; i < 10; i++) {
    const n = i + 1;
    const googleSub = `seed-resident-${n}`;
    const userRes = await client.query<{ id: string }>(
      `insert into haven.users (google_sub, email, full_name, phone, phone_verified_at, is_active)
       values ($1, $2, $3, $4, now(), true)
       on conflict (google_sub) do update set full_name = excluded.full_name
       returning id`,
      [
        googleSub,
        `seed-resident-${n}@haven.test`,
        `Resident ${n}`,
        `+9199999001${String(n).padStart(2, '0')}`,
      ],
    );
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- RETURNING on an upsert always returns exactly one row
    const userId = userRes.rows[0]!.id;
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- i < 10 <= roomIds.length (20 rooms seeded above)
    const roomId = roomIds[i]!;
    const roomNumber = String(101 + i);

    await client.query(
      `insert into haven.residents (user_id, hostel_id, claimed_room, room_id, status, submitted_at, decided_by, decided_at)
       values ($1, $2, $3, $4, 'verified', now() - interval '2 days', $5, now() - interval '1 day')
       on conflict (user_id) do update set status = 'verified', room_id = excluded.room_id`,
      [userId, hostelId, roomNumber, roomId, decidedBy],
    );
    residentIds.push(userId);
  }
  return residentIds;
}

async function seedVisitors(client: pg.Client): Promise<string[]> {
  const genders = ['female', 'male', 'undisclosed'] as const;
  const visitorIds: string[] = [];
  for (let i = 1; i <= 15; i++) {
    const phone = `+9199999000${String(i).padStart(2, '0')}`;
    const res = await client.query<{ id: string }>(
      `insert into haven.visitors (phone, full_name, gender, is_adult_confirmed, consent_version, consent_at)
       values ($1, $2, $3, true, 'v1', now())
       on conflict (phone) do update set full_name = excluded.full_name
       returning id`,
      [phone, `Test Guest ${i}`, genders[i % genders.length]],
    );
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- RETURNING on an upsert always returns exactly one row
    visitorIds.push(res.rows[0]!.id);
  }
  return visitorIds;
}

async function seedGateDevice(
  client: pg.Client,
  hostelId: string,
  pairedBy: string,
): Promise<void> {
  const gate = await client.query<{ id: string }>(
    `select id from haven.gates where hostel_id = $1 limit 1`,
    [hostelId],
  );
  if (gate.rows.length === 0) return;
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- checked rows.length above
  const gateId = gate.rows[0]!.id;

  // Idempotency check by existence, not `on conflict`: token_hash is random by design
  // (a real pairing token must be unguessable), so two seed runs would never collide
  // on it and `on conflict (token_hash) do nothing` would silently insert a second
  // device every time. Guard by label instead — this fake device is identified by
  // what it is, not by its (deliberately random) secret.
  const existing = await client.query(
    `select 1 from haven.gate_devices where gate_id = $1 and label = 'Seed fake gate phone'`,
    [gateId],
  );
  if (existing.rows.length > 0) return;

  const tokenHash = sha256(randomUUID());
  await client.query(
    `insert into haven.gate_devices (gate_id, label, token_hash, paired_by, last_seen_at)
     values ($1, 'Seed fake gate phone', $2, $3, now())`,
    [gateId, tokenHash, pairedBy],
  );
}

type VisitSeed = {
  status:
    | 'pending_host'
    | 'pending_warden'
    | 'approved'
    | 'inside'
    | 'completed'
    | 'rejected'
    | 'expired'
    | 'cancelled';
  type: 'quick_drop' | 'day' | 'overnight_room' | 'guest_room';
  origin: 'invite' | 'walk_in' | 'host_assisted' | 'overnight_request';
  zone: 'gate' | 'visitors_room' | 'room' | 'guest_room';
  overstay: boolean;
  disputed: boolean;
  locationUnverified: boolean;
  exitLocationUnverified: boolean;
};

const ALL_STATUSES: VisitSeed['status'][] = [
  'pending_host',
  'pending_warden',
  'approved',
  'inside',
  'completed',
  'rejected',
  'expired',
  'cancelled',
];

async function seedVisits(
  client: pg.Client,
  hostelId: string,
  residentIds: string[],
  visitorIds: string[],
): Promise<void> {
  // 30 visits covering every status (8) and every flag (4): overstay_since,
  // host_disputed_at, location_unverified, exit_location_unverified (SDD §7.2).
  const seeds: VisitSeed[] = [];

  // Every status appears at least 3 times (24 rows), with varied type/origin/zone.
  for (let i = 0; i < 24; i++) {
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- i % ALL_STATUSES.length is always a valid index into ALL_STATUSES
    const status = ALL_STATUSES[i % ALL_STATUSES.length]!;
    const typeIdx = i % 4;
    const type = (['quick_drop', 'day', 'overnight_room', 'guest_room'] as const)[typeIdx];
    const origin = (['invite', 'walk_in', 'host_assisted', 'overnight_request'] as const)[typeIdx];
    const zone = type === 'guest_room' ? 'guest_room' : type === 'quick_drop' ? 'gate' : 'room';
    seeds.push({
      status,
      type,
      origin,
      zone,
      overstay: false,
      disputed: false,
      locationUnverified: false,
      exitLocationUnverified: false,
    });
  }

  // Explicit flag coverage: one visit each, guaranteeing every flag in SDD §7.2
  // appears at least once regardless of what the loop above produced.
  seeds.push({
    status: 'inside',
    type: 'day',
    origin: 'invite',
    zone: 'room',
    overstay: true,
    disputed: false,
    locationUnverified: false,
    exitLocationUnverified: false,
  });
  seeds.push({
    status: 'inside',
    type: 'day',
    origin: 'walk_in',
    zone: 'room',
    overstay: false,
    disputed: true,
    locationUnverified: false,
    exitLocationUnverified: false,
  });
  seeds.push({
    status: 'inside',
    type: 'quick_drop',
    origin: 'host_assisted',
    zone: 'gate',
    overstay: false,
    disputed: false,
    locationUnverified: true,
    exitLocationUnverified: false,
  });
  seeds.push({
    status: 'completed',
    type: 'day',
    origin: 'invite',
    zone: 'room',
    overstay: false,
    disputed: false,
    locationUnverified: false,
    exitLocationUnverified: true,
  });

  // Pad/trim to exactly 30, cycling the pattern if needed.
  while (seeds.length < 30) {
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- seeds.length % 24 is always a valid index; the loop only runs while seeds.length < 30, and seeds already has at least 24 entries from the first loop above
    seeds.push(seeds[seeds.length % 24]!);
  }
  seeds.length = 30;

  // BR-15 (one `inside` visit per visitor, anywhere) is enforced by a DB-level partial
  // unique index on (visitor_id) WHERE status = 'inside' — so two seed rows that are
  // both 'inside' must never share a visitor, even though non-'inside' rows can reuse
  // visitors freely (the index doesn't apply to them). A plain `i % visitorIds.length`
  // for every row can coincidentally collide on two 'inside' rows; this dedicated
  // counter, advanced only for 'inside' rows, guarantees it never does (6 'inside'
  // rows, 15 visitors — never wraps).
  let insideVisitorCursor = 0;

  for (let i = 0; i < seeds.length; i++) {
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- i < seeds.length by the loop condition
    const seed = seeds[i]!;
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- i % residentIds.length is always a valid index; seedResidents always returns 10 ids before seedVisits runs
    const host = residentIds[i % residentIds.length]!;
    const visitor =
      seed.status === 'inside'
        ? // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- insideVisitorCursor % visitorIds.length is always a valid index
          visitorIds[insideVisitorCursor++ % visitorIds.length]!
        : // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- i % visitorIds.length is always a valid index; seedVisitors always returns 15 ids before seedVisits runs
          visitorIds[i % visitorIds.length]!;
    const nights = seed.type === 'overnight_room' || seed.type === 'guest_room' ? 2 : 0;

    const now = Date.now();
    const windowStart = new Date(now - (i + 1) * 3_600_000); // staggered into the past
    const windowEnd = new Date(
      windowStart.getTime() + (nights > 0 ? nights * 86_400_000 : 3_600_000),
    );

    // Deterministic, not random: a real visit's code is random (generateVisitCode(),
    // used by the API from M2 onward), but seed data needs a stable natural key to
    // upsert on so re-running this script is actually idempotent (SDD §11.9) rather
    // than attempting to insert 30 fresh 'inside' rows every run and hitting BR-15's
    // partial unique index on the second run. "SEEDxx" is a valid 6-char Crockford
    // string (matches the same `^V[0-9A-HJKMNP-TV-Z]{6}$` check as a real code).
    const code = `VSEED${String(i + 1).padStart(2, '0')}`;

    await client.query(
      `insert into haven.visits (
         code, hostel_id, host_id, visitor_id, type, status, origin, zone,
         window_start, window_end, nights, rules_version,
         location_unverified, exit_location_unverified, overstay_since, host_disputed_at,
         first_entry_at, last_exit_at, created_by_type, created_by_id
       ) values (
         $1, $2, $3, $4, $5, $6, $7, $8,
         $9, $10, $11, 1,
         $12, $13, $14, $15,
         $16, $17, 'user', $3
       )
       on conflict (code) do nothing`,
      [
        code,
        hostelId,
        host,
        visitor,
        seed.type,
        seed.status,
        seed.origin,
        seed.zone,
        windowStart.toISOString(),
        windowEnd.toISOString(),
        nights,
        seed.locationUnverified,
        seed.exitLocationUnverified,
        seed.overstay ? new Date(windowEnd.getTime() + 20 * 60_000).toISOString() : null,
        seed.disputed ? new Date().toISOString() : null,
        seed.status === 'inside' || seed.status === 'completed' ? windowStart.toISOString() : null,
        seed.status === 'completed' ? windowEnd.toISOString() : null,
      ],
    );
  }
}

main().catch((err) => {
  console.error('Seed failed:', err);
  process.exitCode = 1;
});
