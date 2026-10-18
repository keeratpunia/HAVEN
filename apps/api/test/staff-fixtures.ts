import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import supertest from 'supertest';
import { sql } from 'kysely';
import { GH8_RULES_CONFIG_V1 } from '@haven/shared';
import type { FakeClock } from '../src/lib/clock.js';
import { generateVisitCode } from '../src/lib/ids.js';
import { db, issueToken, makeGateWithSecret } from './app-test-helpers.js';
import { makeHostel, makeVerifiedHost, makeVisitor } from './visits-fixtures.js';

/**
 * A two-hostel world for the warden/office tests: every role from SDD §3.3 — guest,
 * resident, warden, office, super admin, gate device — with tokens, plus the records the
 * staff capabilities act on.
 */

let seq = 0;
const next = () => (seq += 1);

export async function makeUser(name: string): Promise<string> {
  const n = next();
  const row = await db
    .insertInto('haven.users')
    .values({
      google_sub: `staff-${n}-${randomUUID()}`,
      email: `user${n}-${randomUUID().slice(0, 6)}@haven.test`,
      full_name: name,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
}

export async function grant(
  userId: string,
  role: 'warden' | 'office' | 'super_admin',
  hostelId: string | null,
) {
  await db
    .insertInto('haven.role_assignments')
    .values({ user_id: userId, hostel_id: hostelId, role })
    .execute();
}

export interface HostelWorld {
  hostelId: string;
  gate: { gateId: string; code: string; secret: Buffer };
  wardenId: string;
  officeId: string;
  residentId: string;
  visitorId: string;
}

export async function hostelWorld(): Promise<HostelWorld> {
  const hostelId = await makeHostel(db);
  await sql`insert into haven.hostel_rules (hostel_id, version, config)
            values (${hostelId}, 1, ${JSON.stringify(GH8_RULES_CONFIG_V1)}::jsonb)`.execute(db);
  const gate = await makeGateWithSecret(hostelId);
  const wardenId = await makeUser('Meera Warden');
  await grant(wardenId, 'warden', hostelId);
  const officeId = await makeUser('Omar Office');
  await grant(officeId, 'office', hostelId);
  const residentId = await makeVerifiedHost(db, hostelId);
  const visitorId = await makeVisitor(db);
  return { hostelId, gate, wardenId, officeId, residentId, visitorId };
}

export type Role = 'guest' | 'resident' | 'warden' | 'office' | 'super_admin' | 'gate_device';
export const ROLES: Role[] = [
  'guest',
  'resident',
  'warden',
  'office',
  'super_admin',
  'gate_device',
];

export interface Tokens {
  header: Record<Role, string>;
}

/** `Authorization` header values for every role in hostel `w`. */
export async function tokensFor(
  app: FastifyInstance,
  clock: FakeClock,
  w: HostelWorld,
  superAdminId: string,
) {
  const bearer = async (type: 'user' | 'visitor', id: string) =>
    `Bearer ${await issueToken(clock, { type, id })}`;
  return {
    guest: await bearer('visitor', w.visitorId),
    resident: await bearer('user', w.residentId),
    warden: await bearer('user', w.wardenId),
    office: await bearer('user', w.officeId),
    super_admin: await bearer('user', superAdminId),
    gate_device: `Device ${await pairDevice(app, clock, w)}`,
  } satisfies Record<Role, string>;
}

export async function pairDevice(
  app: FastifyInstance,
  clock: FakeClock,
  w: HostelWorld,
): Promise<string> {
  const { createPairingCode } = await import('../src/gate/devices.js');
  const code = await createPairingCode({
    db,
    clock,
    gateId: w.gate.gateId,
    createdByUserId: w.wardenId,
  });
  const res = await supertest(app.server).post('/v1/gate-devices/pair').send({ code: code.code });
  if (res.status !== 200) throw new Error(`pair failed ${JSON.stringify(res.body)}`);
  return res.body.deviceToken as string;
}

export interface VisitSeed {
  hostelId: string;
  hostId: string;
  visitorId?: string | null;
  status: 'pending_warden' | 'approved' | 'inside' | 'completed';
  type?: 'day' | 'overnight_room' | 'guest_room';
  windowStart: Date;
  windowEnd: Date;
  disputed?: boolean;
  nights?: number;
}

export async function seedVisit(v: VisitSeed): Promise<string> {
  const inside = v.status === 'inside' || v.status === 'completed';
  const row = await db
    .insertInto('haven.visits')
    .values({
      code: generateVisitCode(),
      hostel_id: v.hostelId,
      host_id: v.hostId,
      visitor_id: v.visitorId ?? null,
      invited_name: 'Seeded Guest',
      invited_phone: '+919876500000',
      invited_gender: 'female',
      type: v.type ?? 'day',
      status: v.status,
      origin: v.type && v.type !== 'day' ? 'overnight_request' : 'invite',
      zone: 'room',
      window_start: v.windowStart.toISOString(),
      window_end: v.windowEnd.toISOString(),
      nights: v.nights ?? 0,
      rules_version: 1,
      created_by_type: 'user',
      created_by_id: v.hostId,
      first_entry_at: inside ? v.windowStart.toISOString() : null,
      last_entry_at: inside ? v.windowStart.toISOString() : null,
      host_disputed_at: v.disputed ? v.windowStart.toISOString() : null,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
}

export async function seedCharge(p: {
  hostelId: string;
  residentId: string;
  visitId?: string | null;
  amount?: number;
  status?: 'pending' | 'confirmed';
}) {
  const row = await db
    .insertInto('haven.charges')
    .values({
      hostel_id: p.hostelId,
      resident_id: p.residentId,
      visit_id: p.visitId ?? null,
      kind: p.visitId ? 'overnight_room' : 'fine',
      amount_inr: p.amount ?? 100,
      description: 'Overnight room stay, 2 night(s).',
      status: p.status ?? 'pending',
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
}

/** A resident who has submitted for verification, with an ID card and selfie stored. */
export async function pendingResident(
  hostelId: string,
  storage: { put(path: string, b: Buffer): Promise<void> },
) {
  const userId = await makeUser('Neha Pending');
  const card = await db
    .insertInto('haven.media')
    .values({
      kind: 'resident_id_card',
      bucket: 'resident-docs',
      path: `${userId}/card-${next()}.jpg`,
      sha256: Buffer.from(randomUUID()),
      bytes: 4,
    })
    .returning(['id', 'path'])
    .executeTakeFirstOrThrow();
  const selfie = await db
    .insertInto('haven.media')
    .values({
      kind: 'resident_selfie',
      bucket: 'resident-docs',
      path: `${userId}/selfie-${next()}.jpg`,
      sha256: Buffer.from(randomUUID()),
      bytes: 4,
    })
    .returning(['id', 'path'])
    .executeTakeFirstOrThrow();
  await storage.put(card.path, Buffer.from('card'));
  await storage.put(selfie.path, Buffer.from('self'));
  await db
    .insertInto('haven.residents')
    .values({
      user_id: userId,
      hostel_id: hostelId,
      claimed_room: '305',
      status: 'pending',
      id_card_media_id: card.id,
      selfie_media_id: selfie.id,
      submitted_at: new Date().toISOString(),
    })
    .execute();
  return { userId, cardMediaId: card.id, cardPath: card.path };
}

export { makeVisitor };
