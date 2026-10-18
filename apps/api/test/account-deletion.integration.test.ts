import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import supertest from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { FakeClock } from '../src/lib/clock.js';
import { processDeletionRequests } from '../src/account/deletion.js';
import { generateVisitCode } from '../src/lib/ids.js';
import { resetAllHavenTables } from './db-test-helper.js';
import { buildTestApp, db, issueToken, MemoryMediaStorage } from './app-test-helpers.js';
import { hostelWorld, seedCharge, type HostelWorld } from './staff-fixtures.js';

/**
 * Account deletion (FR-09, SDD §16.6) through `POST /v1/me/deletion-request` and the
 * deletion worker.
 */

const NOW = new Date('2026-10-18T10:30:00.000Z'); // 16:00 IST
const HOUR = 3_600_000;
let clock: FakeClock;
let app: FastifyInstance;
let storage: MemoryMediaStorage;
let w: HostelWorld;

beforeAll(async () => {
  clock = new FakeClock(NOW);
  storage = new MemoryMediaStorage();
  app = await buildTestApp(clock, { mediaStorage: storage });
});
afterAll(async () => {
  await app.close();
});
beforeEach(async () => {
  await resetAllHavenTables();
  clock.set(NOW);
  w = await hostelWorld();
});

const request = (token: string, body: object = {}) =>
  supertest(app.server)
    .post('/v1/me/deletion-request')
    .set('Authorization', `Bearer ${token}`)
    .send(body);
const me = (token: string) =>
  supertest(app.server).get('/v1/me').set('Authorization', `Bearer ${token}`);
const work = () => processDeletionRequests({ db, storage, clock });

async function visit(p: {
  visitorId?: string;
  hostId?: string;
  status: 'approved' | 'inside' | 'completed';
  startInMs: number;
  lengthMs?: number;
}) {
  const start = new Date(NOW.getTime() + p.startInMs);
  const row = await db
    .insertInto('haven.visits')
    .values({
      code: generateVisitCode(),
      hostel_id: w.hostelId,
      host_id: p.hostId ?? w.residentId,
      visitor_id: p.visitorId ?? w.visitorId,
      type: 'day',
      status: p.status,
      origin: 'invite',
      zone: 'visitors_room',
      window_start: start.toISOString(),
      window_end: new Date(start.getTime() + (p.lengthMs ?? 2 * HOUR)).toISOString(),
      rules_version: 1,
      created_by_type: 'user',
      created_by_id: w.residentId,
      first_entry_at: p.status === 'approved' ? null : start.toISOString(),
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
}

async function ownedPhoto(
  owner: { visitorId?: string; userId?: string },
  kind: 'visitor_profile' | 'gate_photo' | 'resident_selfie',
) {
  const bucket =
    kind === 'resident_selfie'
      ? 'resident-docs'
      : kind === 'gate_photo'
        ? 'gate-photos'
        : 'visitor-photos';
  const path = `${owner.visitorId ?? owner.userId ?? 'x'}/${randomUUID()}.jpg`;
  await storage.put({ bucket, path }, Buffer.from('jpeg'));
  await db
    .insertInto('haven.media')
    .values({
      kind,
      bucket,
      path,
      sha256: Buffer.from(randomUUID()),
      bytes: 4,
      owner_visitor_id: owner.visitorId ?? null,
      owner_user_id: owner.userId ?? null,
    })
    .execute();
  return { bucket, path } as const;
}

describe('POST /v1/me/deletion-request (§16.6 step 1)', () => {
  it('records the request (202), signs the guest out everywhere at once, and is audited', async () => {
    const phone = await issueToken(clock, { type: 'visitor', id: w.visitorId });
    const laptop = await issueToken(clock, { type: 'visitor', id: w.visitorId });
    expect((await me(laptop)).status).toBe(200);

    const res = await request(phone, { reason: 'No longer visiting' });
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ status: 'pending', waitingFor: null, waitUntil: null });

    for (const token of [phone, laptop]) {
      const after = await me(token);
      expect(after.status).toBe(401);
      expect(after.body.error.code).toBe('SESSION_REVOKED');
    }
    const live = await db
      .selectFrom('haven.sessions')
      .select('id')
      .where('principal_id', '=', w.visitorId)
      .where('revoked_at', 'is', null)
      .execute();
    expect(live).toEqual([]);
    const audit = await db
      .selectFrom('haven.audit_log')
      .select(['action', 'after'])
      .where('action', '=', 'account.deletion_requested')
      .execute();
    expect(audit).toEqual([
      { action: 'account.deletion_requested', after: { subjectType: 'visitor', waitingFor: null } },
    ]);
    expect(JSON.stringify(audit)).not.toContain('No longer visiting');
  });

  it('a resident who owes charges is refused (409 CONFLICT, UNPAID_CHARGES) and stays signed in', async () => {
    await seedCharge({
      hostelId: w.hostelId,
      residentId: w.residentId,
      amount: 150,
      status: 'confirmed',
    });
    const token = await issueToken(clock, { type: 'user', id: w.residentId });
    const res = await request(token);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({
      code: 'CONFLICT',
      details: { reason: 'UNPAID_CHARGES', unpaidInr: 150 },
    });
    expect((await me(token)).status).toBe(200);
    expect(await db.selectFrom('haven.deletion_requests').select('id').execute()).toEqual([]);

    // Once the office marks it paid, the resident can delete.
    await db.updateTable('haven.charges').set({ status: 'paid', receipt_no: 'GH8-0001' }).execute();
    expect((await request(token)).status).toBe(202);
  });

  it('staff can’t self-delete (403 FORBIDDEN): their access ends by deactivation (FR-07)', async () => {
    const token = await issueToken(clock, { type: 'user', id: w.wardenId });
    const res = await request(token);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('a second request is the same request', async () => {
    await request(await issueToken(clock, { type: 'visitor', id: w.visitorId }));
    await request(await issueToken(clock, { type: 'visitor', id: w.visitorId }));
    expect(await db.selectFrom('haven.deletion_requests').select('id').execute()).toHaveLength(1);
  });
});

describe('§16.6 step 2: waits while the guest is inside or has a visit in the next 24 h', () => {
  it('inside now: deletion waits (and says until when); after check-out the worker completes it', async () => {
    const id = await visit({ status: 'inside', startInMs: -HOUR });
    const res = await request(await issueToken(clock, { type: 'visitor', id: w.visitorId }));
    expect(res.status).toBe(202);
    expect(res.body).toEqual({
      status: 'pending',
      waitingFor: 'inside',
      waitUntil: new Date(NOW.getTime() + HOUR).toISOString(),
    });

    expect(await work()).toEqual({ completed: 0, waiting: 1 });
    // Signing in again (e.g. to check out at the gate) shows the pending deletion.
    const again = await me(await issueToken(clock, { type: 'visitor', id: w.visitorId }));
    expect(again.body.deletionRequest).toEqual({ status: 'pending', waitingFor: 'inside' });

    await db
      .updateTable('haven.visits')
      .set({ status: 'completed', close_reason: 'checked_out' })
      .where('id', '=', id)
      .execute();
    expect(await work()).toEqual({ completed: 1, waiting: 0 });
  });

  it('a visit starting in 23 h waits; one starting in 25 h does not — and is cancelled', async () => {
    const soon = await visit({ status: 'approved', startInMs: 23 * HOUR });
    const res = await request(await issueToken(clock, { type: 'visitor', id: w.visitorId }));
    expect(res.body.waitingFor).toBe('upcoming_visit');
    expect(await work()).toEqual({ completed: 0, waiting: 1 });

    await db
      .updateTable('haven.visits')
      .set({
        window_start: new Date(NOW.getTime() + 25 * HOUR).toISOString(),
        window_end: new Date(NOW.getTime() + 27 * HOUR).toISOString(),
      })
      .where('id', '=', soon)
      .execute();
    expect(await work()).toEqual({ completed: 1, waiting: 0 });
    const v = await db
      .selectFrom('haven.visits')
      .select(['status', 'cancel_reason'])
      .where('id', '=', soon)
      .executeTakeFirstOrThrow();
    expect(v).toEqual({ status: 'cancelled', cancel_reason: 'guest deleted their account' });
  });
});

describe('§16.6 step 3: the worker deletes photos, anonymises, and keeps visit rows', () => {
  it('guest: photos deleted, identity anonymised as §16.5, tokens and sessions gone, visits kept', async () => {
    const pastVisit = await visit({ status: 'completed', startInMs: -48 * HOUR });
    const profile = await ownedPhoto({ visitorId: w.visitorId }, 'visitor_profile');
    const gatePhoto = await ownedPhoto({ visitorId: w.visitorId }, 'gate_photo');
    await request(await issueToken(clock, { type: 'visitor', id: w.visitorId }));
    clock.set(new Date(NOW.getTime() + 15 * 60_000)); // the next worker run

    expect(await work()).toEqual({ completed: 1, waiting: 0 });
    expect(await storage.get(profile)).toBeNull();
    expect(await storage.get(gatePhoto)).toBeNull();
    const media = await db
      .selectFrom('haven.media')
      .select('deleted_at')
      .where('owner_visitor_id', '=', w.visitorId)
      .execute();
    expect(media.every((m) => m.deleted_at !== null)).toBe(true);
    const visitor = await db
      .selectFrom('haven.visitors')
      .select(['full_name', 'phone', 'anonymised_at'])
      .where('id', '=', w.visitorId)
      .executeTakeFirstOrThrow();
    expect(visitor).toEqual({ full_name: 'Former guest', phone: null, anonymised_at: clock.now() });
    const kept = await db
      .selectFrom('haven.visits')
      .select(['id', 'visitor_id'])
      .where('id', '=', pastVisit)
      .executeTakeFirstOrThrow();
    expect(kept.visitor_id).toBe(w.visitorId);
    const req = await db
      .selectFrom('haven.deletion_requests')
      .select(['status', 'completed_at'])
      .executeTakeFirstOrThrow();
    expect(req).toEqual({ status: 'completed', completed_at: clock.now() });
    expect(
      await db
        .selectFrom('haven.audit_log')
        .select('action')
        .where('action', '=', 'account.deleted')
        .execute(),
    ).toHaveLength(1);
    // A later sign-in with the same number starts a brand-new guest; nothing links back.
    expect(await work()).toEqual({ completed: 0, waiting: 0 });
  });

  it('resident: selfie deleted, user anonymised and deactivated, marked left, future hosted visits cancelled', async () => {
    await db
      .insertInto('haven.push_tokens')
      .values({ user_id: w.residentId, expo_token: 'ExponentPushToken[r]', platform: 'android' })
      .execute();
    const selfie = await ownedPhoto({ userId: w.residentId }, 'resident_selfie');
    const future = await visit({ status: 'approved', startInMs: 72 * HOUR });
    const token = await issueToken(clock, { type: 'user', id: w.residentId });
    expect((await request(token)).status).toBe(202);
    const tokens = await db
      .selectFrom('haven.push_tokens')
      .select('disabled_at')
      .where('user_id', '=', w.residentId)
      .execute();
    expect(tokens.every((t) => t.disabled_at !== null)).toBe(true);

    expect(await work()).toEqual({ completed: 1, waiting: 0 });
    expect(await storage.get(selfie)).toBeNull();
    const user = await db
      .selectFrom('haven.users')
      .select(['full_name', 'email', 'phone', 'is_active', 'anonymised_at'])
      .where('id', '=', w.residentId)
      .executeTakeFirstOrThrow();
    expect(user).toEqual({
      full_name: 'Former resident',
      email: `deleted-${w.residentId}@deleted.invalid`,
      phone: null,
      is_active: false,
      anonymised_at: NOW,
    });
    const resident = await db
      .selectFrom('haven.residents')
      .select('status')
      .where('user_id', '=', w.residentId)
      .executeTakeFirstOrThrow();
    expect(resident.status).toBe('left');
    const v = await db
      .selectFrom('haven.visits')
      .select('status')
      .where('id', '=', future)
      .executeTakeFirstOrThrow();
    expect(v.status).toBe('cancelled');
    expect((await me(token)).status).toBe(401);
  });

  it('a resident who runs up a new charge after asking waits until the office clears it', async () => {
    await request(await issueToken(clock, { type: 'user', id: w.residentId }));
    await seedCharge({ hostelId: w.hostelId, residentId: w.residentId, amount: 400 });
    expect(await work()).toEqual({ completed: 0, waiting: 1 });
    const req = await db
      .selectFrom('haven.deletion_requests')
      .select('waiting_for')
      .executeTakeFirstOrThrow();
    expect(req.waiting_for).toBe('unpaid_charges');
  });
});
