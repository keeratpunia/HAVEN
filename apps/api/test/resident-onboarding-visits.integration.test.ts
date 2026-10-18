import type { FastifyInstance } from 'fastify';
import supertest from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { FakeClock } from '../src/lib/clock.js';
import { resetAllHavenTables } from './db-test-helper.js';
import { makeHostel, makeVerifiedHost, makeVisitor, makeWarden } from './visits-fixtures.js';
import {
  buildTestApp,
  db,
  idem,
  issueToken,
  makeGateWithSecret,
  MemoryMediaStorage,
  tinyJpeg,
  WEB_BASE_URL,
} from './app-test-helpers.js';

// 2026-10-12 16:12 IST (Monday) — inside visiting hours, before the 20:00 entry cut-off.
const NOW = new Date('2026-10-12T10:42:00.000Z');
const HOUR = 3_600_000;

let app: FastifyInstance;
let clock: FakeClock;
let media: MemoryMediaStorage;

beforeEach(async () => {
  await resetAllHavenTables();
  clock = new FakeClock(NOW);
  media = new MemoryMediaStorage();
  app = await buildTestApp(clock, { mediaStorage: media });
});

async function newGoogleUser(name = 'Priya Sharma') {
  const row = await db
    .insertInto('haven.users')
    .values({
      google_sub: `sub-${Math.random()}`,
      email: `${Math.random()}@gmail.test`,
      full_name: name,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
}

function inviteBody(overrides: Record<string, unknown> = {}) {
  return {
    kind: 'invite',
    guest: { name: 'Simran Kaur', phone: '+919812345678', gender: 'female' },
    type: 'day',
    windowStart: NOW.toISOString(),
    windowEnd: new Date(NOW.getTime() + 3 * HOUR).toISOString(),
    ...overrides,
  };
}

async function createInvite(token: string, overrides: Record<string, unknown> = {}) {
  return supertest(app.server)
    .post('/v1/visits')
    .set('Authorization', `Bearer ${token}`)
    .send(inviteBody(overrides));
}

describe('resident onboarding (SDD F7, FR-04)', () => {
  it('walks R-02 → R-03 → submit → R-04 and notifies wardens with N-RES-SUBMITTED', async () => {
    const hostelId = await makeHostel(db);
    const wardenId = await makeWarden(db, hostelId);
    const userId = await newGoogleUser();
    const token = await issueToken(clock, { type: 'user', id: userId });
    const auth = { Authorization: `Bearer ${token}` };

    const draft = await supertest(app.server)
      .post('/v1/residents/me')
      .set(auth)
      .send({ hostelId, room: '214' });
    expect(draft.status).toBe(201);

    for (const kind of ['id_card', 'selfie']) {
      const res = await supertest(app.server)
        .post('/v1/residents/me/documents')
        .set(auth)
        .field('kind', kind)
        .attach('photo', await tinyJpeg(), 'doc.jpg');
      expect(res.status).toBe(200);
      expect(res.body.photoId).toMatch(/^[0-9a-f-]{36}$/);
    }

    // Submitting before the phone is verified (R-02) is refused, naming what's missing.
    const early = await supertest(app.server).post('/v1/residents/me/submit').set(auth);
    expect(early.status).toBe(400);
    expect(early.body.error.details.missing).toEqual(['phone']);

    await supertest(app.server)
      .post('/v1/auth/otp/request')
      .send({ phone: '+919999900001', purpose: 'phone_verify' })
      .expect(202);
    await supertest(app.server)
      .post('/v1/auth/otp/verify')
      .set(auth)
      .send({ phone: '+919999900001', code: '123456', purpose: 'phone_verify' })
      .expect(200);

    const submit = await supertest(app.server).post('/v1/residents/me/submit').set(auth);
    expect(submit.status).toBe(204);

    const me = await supertest(app.server).get('/v1/me').set(auth);
    expect(me.body.residentStatus).toBe('pending');
    expect(me.body.resident).toMatchObject({
      hostelId,
      room: '214',
      status: 'pending',
      hasIdCard: true,
      hasSelfie: true,
      canResubmit: false,
    });
    expect(me.body.resident.submittedAt).toBe(NOW.toISOString());

    const notif = await db
      .selectFrom('haven.notifications')
      .selectAll()
      .where('kind', '=', 'N-RES-SUBMITTED')
      .executeTakeFirstOrThrow();
    expect(notif.recipient_id).toBe(wardenId);
    expect(notif.title).toBe('New resident to verify');
    expect(notif.body).toBe('Priya Sharma, room 214.');

    // Duplicate submit and late edits are refused.
    expect((await supertest(app.server).post('/v1/residents/me/submit').set(auth)).status).toBe(
      409,
    );
    expect(
      (
        await supertest(app.server)
          .post('/v1/residents/me')
          .set(auth)
          .send({ hostelId, room: '215' })
      ).status,
    ).toBe(409);
  });

  it('lets a rejected resident resubmit exactly once', async () => {
    const hostelId = await makeHostel(db);
    const userId = await newGoogleUser();
    await db
      .updateTable('haven.users')
      .set({ phone: '+919999900002', phone_verified_at: NOW.toISOString() })
      .where('id', '=', userId)
      .execute();
    const doc = await db
      .insertInto('haven.media')
      .values({
        kind: 'resident_id_card',
        bucket: 'resident-docs',
        path: `${userId}/x.jpg`,
        sha256: Buffer.from('a'),
        bytes: 1,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await db
      .insertInto('haven.residents')
      .values({
        user_id: userId,
        hostel_id: hostelId,
        claimed_room: '101',
        status: 'rejected',
        rejection_reason: 'ID card unreadable',
        id_card_media_id: doc.id,
        selfie_media_id: doc.id,
        submitted_at: NOW.toISOString(),
      })
      .execute();
    const auth = {
      Authorization: `Bearer ${await issueToken(clock, { type: 'user', id: userId })}`,
    };

    const me = await supertest(app.server).get('/v1/me').set(auth);
    expect(me.body.resident).toMatchObject({
      status: 'rejected',
      rejectionReason: 'ID card unreadable',
      canResubmit: true,
    });

    expect((await supertest(app.server).post('/v1/residents/me/submit').set(auth)).status).toBe(
      204,
    );
    // Rejected a second time: no resubmission left.
    await db
      .updateTable('haven.residents')
      .set({ status: 'rejected' })
      .where('user_id', '=', userId)
      .execute();
    const again = await supertest(app.server).post('/v1/residents/me/submit').set(auth);
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('CONFLICT');
  });

  it('refuses onboarding calls from guests and documents without a draft', async () => {
    const hostelId = await makeHostel(db);
    const visitorToken = await issueToken(clock, { type: 'visitor', id: await makeVisitor(db) });
    const res = await supertest(app.server)
      .post('/v1/residents/me')
      .set('Authorization', `Bearer ${visitorToken}`)
      .send({ hostelId, room: '101' });
    expect(res.status).toBe(401);

    const userToken = await issueToken(clock, { type: 'user', id: await newGoogleUser() });
    const doc = await supertest(app.server)
      .post('/v1/residents/me/documents')
      .set('Authorization', `Bearer ${userToken}`)
      .field('kind', 'selfie')
      .attach('photo', await tinyJpeg(), 'doc.jpg');
    expect(doc.status).toBe(400);
  });
});

describe('invites, preview and edits (FR-10, FR-11, FR-13)', () => {
  it('creates an invite whose VisitDTO carries allowedActions and a working invite link', async () => {
    const hostelId = await makeHostel(db);
    const hostId = await makeVerifiedHost(db, hostelId);
    const token = await issueToken(clock, { type: 'user', id: hostId });

    const res = await createInvite(token);
    expect(res.status).toBe(201);
    expect(res.body.inviteUrl).toMatch(new RegExp(`^${WEB_BASE_URL}/i/[A-Za-z0-9_-]{22}$`));
    expect(res.body.visit).toMatchObject({
      status: 'approved',
      origin: 'invite',
      zone: 'room',
      guest: { name: 'Simran Kaur', phoneMasked: '+91•••••45678' },
      host: { displayName: 'Test H.' },
    });
    expect(res.body.visit.allowedActions).toEqual(['cancel', 'edit', 'share_invite']);

    const inviteToken = res.body.inviteUrl.split('/i/')[1];
    expect((await supertest(app.server).get(`/v1/invites/${inviteToken}`)).status).toBe(200);

    // Resend link: the old token stops working (SDD §9.6).
    const relink = await supertest(app.server)
      .post(`/v1/visits/${res.body.visit.id}/invite-link`)
      .set('Authorization', `Bearer ${token}`);
    expect(relink.status).toBe(200);
    expect((await supertest(app.server).get(`/v1/invites/${inviteToken}`)).status).toBe(404);
    const fresh = relink.body.inviteUrl.split('/i/')[1];
    expect((await supertest(app.server).get(`/v1/invites/${fresh}`)).status).toBe(200);
  });

  it('previews without writing, returning the rules decision', async () => {
    const hostelId = await makeHostel(db);
    const hostId = await makeVerifiedHost(db, hostelId);
    const token = await issueToken(clock, { type: 'user', id: hostId });

    const ok = await supertest(app.server)
      .post('/v1/visits/preview')
      .set('Authorization', `Bearer ${token}`)
      .send(inviteBody());
    expect(ok.body).toMatchObject({ decision: 'allow', codes: [], zone: 'room', nights: 0 });

    const late = await supertest(app.server)
      .post('/v1/visits/preview')
      .set('Authorization', `Bearer ${token}`)
      .send(inviteBody({ windowEnd: '2026-10-12T17:00:00.000Z' })); // 22:30 IST
    expect(late.body).toMatchObject({ decision: 'deny', codes: ['WINDOW_INVALID'] });

    const count = await db
      .selectFrom('haven.visits')
      .select((eb) => eb.fn.countAll().as('n'))
      .executeTakeFirstOrThrow();
    expect(Number(count.n)).toBe(0);
  });

  it('TC-RULE-13: a pending resident creating an invite is denied HOST_NOT_VERIFIED', async () => {
    const hostelId = await makeHostel(db);
    const userId = await newGoogleUser();
    await db
      .insertInto('haven.residents')
      .values({ user_id: userId, hostel_id: hostelId, claimed_room: '101' })
      .execute();
    const res = await createInvite(await issueToken(clock, { type: 'user', id: userId }));
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('HOST_NOT_VERIFIED');
  });

  it('edits the window before entry, refusing a window that breaks the rules', async () => {
    const hostelId = await makeHostel(db);
    const hostId = await makeVerifiedHost(db, hostelId);
    const token = await issueToken(clock, { type: 'user', id: hostId });
    const visitId = (await createInvite(token)).body.visit.id;

    const newEnd = new Date(NOW.getTime() + 4 * HOUR).toISOString();
    const edit = await supertest(app.server)
      .patch(`/v1/visits/${visitId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ windowEnd: newEnd });
    expect(edit.status).toBe(200);
    expect(edit.body.windowEnd).toBe(newEnd);

    const bad = await supertest(app.server)
      .patch(`/v1/visits/${visitId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ windowEnd: '2026-10-12T17:00:00.000Z' });
    expect(bad.status).toBe(422);
    expect(bad.body.error.code).toBe('WINDOW_INVALID');
  });

  it('cancels before check-in; a second cancel is an invalid transition', async () => {
    const hostelId = await makeHostel(db);
    const hostId = await makeVerifiedHost(db, hostelId);
    const token = await issueToken(clock, { type: 'user', id: hostId });
    const visitId = (await createInvite(token)).body.visit.id;

    const cancel = await supertest(app.server)
      .post(`/v1/visits/${visitId}/cancel`)
      .set('Authorization', `Bearer ${token}`)
      .send({ reason: 'Plans changed' });
    expect(cancel.status).toBe(200);
    expect(cancel.body.status).toBe('cancelled');
    expect(cancel.body.allowedActions).toEqual([]);

    const again = await supertest(app.server)
      .post(`/v1/visits/${visitId}/cancel`)
      .set('Authorization', `Bearer ${token}`)
      .send({});
    expect(again.status).toBe(409);
  });
});

describe('overnight requests, quota and charges (FR-14, FR-15, BR-05, BR-07, BR-08)', () => {
  function overnightBody(overrides: Record<string, unknown> = {}) {
    return {
      kind: 'overnight',
      guest: { name: 'Asha Rani', phone: '+919812300000', gender: 'female' },
      type: 'overnight_room',
      arrivalDate: '2026-10-20',
      departureDate: '2026-10-22',
      ...overrides,
    };
  }

  it('previews nights, charge and quota, then requests and notifies wardens', async () => {
    const hostelId = await makeHostel(db);
    const hostId = await makeVerifiedHost(db, hostelId);
    const wardenId = await makeWarden(db, hostelId);
    const token = await issueToken(clock, { type: 'user', id: hostId });

    const preview = await supertest(app.server)
      .post('/v1/visits/preview')
      .set('Authorization', `Bearer ${token}`)
      .send(overnightBody());
    expect(preview.body).toEqual({
      decision: 'allow',
      codes: [],
      zone: 'room',
      nights: 2,
      chargeInr: 100,
      quota: [{ month: '2026-10', used: 0, after: 2 }],
    });

    const create = await supertest(app.server)
      .post('/v1/visits')
      .set('Authorization', `Bearer ${token}`)
      .send(overnightBody());
    expect(create.status).toBe(201);
    expect(create.body.inviteUrl).toBeUndefined();
    expect(create.body.visit).toMatchObject({
      status: 'pending_warden',
      nights: 2,
      allowedActions: ['cancel'],
    });
    // Window derived from the dates: 08:00 IST arrival → 12:00 IST departure.
    expect(create.body.visit.windowStart).toBe('2026-10-20T02:30:00.000Z');
    expect(create.body.visit.windowEnd).toBe('2026-10-22T06:30:00.000Z');

    const notif = await db
      .selectFrom('haven.notifications')
      .selectAll()
      .where('kind', '=', 'N-OVERNIGHT-REQ')
      .executeTakeFirstOrThrow();
    expect(notif.recipient_id).toBe(wardenId);
    expect(notif.title).toBe('Overnight request');
    expect(notif.body).toMatch(/^Test Host \(room R\d+\) requests 2 night\(s\) for Asha Rani\.$/);
  });

  it('denies a 4th night in a month (QUOTA_EXCEEDED) and an opposite-gender overnight', async () => {
    const hostelId = await makeHostel(db);
    const hostId = await makeVerifiedHost(db, hostelId);
    const token = await issueToken(clock, { type: 'user', id: hostId });
    // An already-completed 3-night stay this month still uses the quota.
    await db
      .insertInto('haven.visits')
      .values({
        code: 'V2345AB',
        hostel_id: hostelId,
        host_id: hostId,
        invited_name: 'Old Guest',
        invited_phone: '+919812300001',
        type: 'overnight_room',
        status: 'completed',
        origin: 'overnight_request',
        zone: 'room',
        window_start: '2026-10-02T02:30:00.000Z',
        window_end: '2026-10-05T06:30:00.000Z',
        nights: 3,
        rules_version: 1,
        created_by_type: 'user',
        created_by_id: hostId,
      })
      .execute();

    const quota = await supertest(app.server)
      .get('/v1/me/quota?month=2026-10')
      .set('Authorization', `Bearer ${token}`);
    expect(quota.body).toEqual({ month: '2026-10', used: 3, limit: 3, remaining: 0 });

    const res = await supertest(app.server)
      .post('/v1/visits')
      .set('Authorization', `Bearer ${token}`)
      .send(overnightBody({ arrivalDate: '2026-10-25', departureDate: '2026-10-26' }));
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('QUOTA_EXCEEDED');

    const male = await supertest(app.server)
      .post('/v1/visits')
      .set('Authorization', `Bearer ${token}`)
      .send(
        overnightBody({
          arrivalDate: '2026-11-03',
          departureDate: '2026-11-04',
          guest: { name: 'Raj', phone: '+919812300002', gender: 'male' },
        }),
      );
    expect(male.status).toBe(422);
    expect(male.body.error.code).toBe('TYPE_NOT_ALLOWED_FOR_GENDER');
  });

  it('shows the pending charge on R-14 after the warden approves', async () => {
    const hostelId = await makeHostel(db);
    const hostId = await makeVerifiedHost(db, hostelId);
    const wardenId = await makeWarden(db, hostelId);
    const token = await issueToken(clock, { type: 'user', id: hostId });
    const create = await supertest(app.server)
      .post('/v1/visits')
      .set('Authorization', `Bearer ${token}`)
      .send(overnightBody({ type: 'guest_room' }));
    const visitId = create.body.visit.id;

    const wardenToken = await issueToken(clock, { type: 'user', id: wardenId }, [
      { h: hostelId, r: 'warden' },
    ]);
    const approve = await supertest(app.server)
      .post(`/v1/visits/${visitId}/approve`)
      .set('Authorization', `Bearer ${wardenToken}`)
      .set('Idempotency-Key', idem())
      .send({});
    expect(approve.status).toBe(200);
    expect(approve.body.status).toBe('approved');

    const charges = await supertest(app.server)
      .get('/v1/me/charges')
      .set('Authorization', `Bearer ${token}`);
    expect(charges.body.items).toEqual([
      expect.objectContaining({ kind: 'guest_room', amountInr: 300, status: 'pending', visitId }),
    ]);
    const decided = await db
      .selectFrom('haven.notifications')
      .selectAll()
      .where('kind', '=', 'N-OVERNIGHT-DECIDED')
      .executeTakeFirstOrThrow();
    expect(decided.title).toBe('Overnight request approved');
    expect(decided.body).toBe('Share the invite with Asha Rani.');
    // N-CHARGE (§15.2 "Charge created or marked paid"), in-app to the resident, in the
    // same transaction as the approval.
    const charged = await db
      .selectFrom('haven.notifications')
      .selectAll()
      .where('kind', '=', 'N-CHARGE')
      .executeTakeFirstOrThrow();
    expect(charged).toMatchObject({
      channel: 'in_app',
      recipient_id: hostId,
      title: null,
      body: '₹300 Guest room stay, 2 night(s). — pending',
    });

    // Now approved, the host can share the invite.
    const after = await supertest(app.server)
      .get(`/v1/visits/${visitId}`)
      .set('Authorization', `Bearer ${token}`);
    expect(after.body.allowedActions).toEqual(['cancel', 'share_invite']);
  });

  it('a warden declining must give a reason (SDD §12.6)', async () => {
    const hostelId = await makeHostel(db);
    const hostId = await makeVerifiedHost(db, hostelId);
    const wardenId = await makeWarden(db, hostelId);
    const token = await issueToken(clock, { type: 'user', id: hostId });
    const visitId = (
      await supertest(app.server)
        .post('/v1/visits')
        .set('Authorization', `Bearer ${token}`)
        .send(overnightBody())
    ).body.visit.id;
    const wardenToken = await issueToken(clock, { type: 'user', id: wardenId }, [
      { h: hostelId, r: 'warden' },
    ]);

    const noReason = await supertest(app.server)
      .post(`/v1/visits/${visitId}/reject`)
      .set('Authorization', `Bearer ${wardenToken}`)
      .set('Idempotency-Key', idem())
      .send({});
    expect(noReason.status).toBe(400);
    const ok = await supertest(app.server)
      .post(`/v1/visits/${visitId}/reject`)
      .set('Authorization', `Bearer ${wardenToken}`)
      .set('Idempotency-Key', idem())
      .send({ reason: 'Room inspection that week' });
    expect(ok.body.status).toBe('rejected');
    const decided = await db
      .selectFrom('haven.notifications')
      .select(['title', 'body'])
      .where('kind', '=', 'N-OVERNIGHT-DECIDED')
      .executeTakeFirstOrThrow();
    expect(decided).toEqual({
      title: 'Overnight request declined',
      body: 'Room inspection that week',
    });
  });
});

describe('visit history and detail (FR-16) with authorization boundaries', () => {
  it('buckets and pages the host’s visits', async () => {
    const hostelId = await makeHostel(db);
    const hostId = await makeVerifiedHost(db, hostelId);
    const token = await issueToken(clock, { type: 'user', id: hostId });
    for (let i = 0; i < 3; i += 1) {
      await createInvite(token, { guest: { name: `Guest ${i}`, phone: `+91981234567${i}` } });
    }
    const cancelled = (
      await createInvite(token, { guest: { name: 'Gone', phone: '+919812345689' } })
    ).body.visit.id;
    await supertest(app.server)
      .post(`/v1/visits/${cancelled}/cancel`)
      .set('Authorization', `Bearer ${token}`)
      .send({});

    const page1 = await supertest(app.server)
      .get('/v1/me/hosted-visits?bucket=upcoming&limit=2')
      .set('Authorization', `Bearer ${token}`);
    expect(page1.body.items).toHaveLength(2);
    expect(page1.body.nextCursor).toEqual(expect.any(String));
    const page2 = await supertest(app.server)
      .get(`/v1/me/hosted-visits?bucket=upcoming&limit=2&cursor=${page1.body.nextCursor}`)
      .set('Authorization', `Bearer ${token}`);
    expect(page2.body.items).toHaveLength(1);
    expect(page2.body.nextCursor).toBeNull();

    const history = await supertest(app.server)
      .get('/v1/me/hosted-visits?bucket=history')
      .set('Authorization', `Bearer ${token}`);
    expect(history.body.items.map((v: { id: string }) => v.id)).toEqual([cancelled]);
    const inside = await supertest(app.server)
      .get('/v1/me/hosted-visits?bucket=inside')
      .set('Authorization', `Bearer ${token}`);
    expect(inside.body.items).toEqual([]);
  });

  it('TC-SEC-01/02: another resident or an unrelated guest gets 404 for a visit, and its actions', async () => {
    const hostelId = await makeHostel(db);
    const hostA = await makeVerifiedHost(db, hostelId);
    const hostB = await makeVerifiedHost(db, hostelId);
    const tokenA = await issueToken(clock, { type: 'user', id: hostA });
    const tokenB = await issueToken(clock, { type: 'user', id: hostB });
    const guestToken = await issueToken(clock, { type: 'visitor', id: await makeVisitor(db) });
    const visitId = (await createInvite(tokenA)).body.visit.id;

    for (const bearer of [tokenB, guestToken]) {
      expect(
        (
          await supertest(app.server)
            .get(`/v1/visits/${visitId}`)
            .set('Authorization', `Bearer ${bearer}`)
        ).status,
      ).toBe(404);
    }
    const cancelByB = await supertest(app.server)
      .post(`/v1/visits/${visitId}/cancel`)
      .set('Authorization', `Bearer ${tokenB}`)
      .send({});
    expect(cancelByB.status).toBe(404);
    const editByB = await supertest(app.server)
      .patch(`/v1/visits/${visitId}`)
      .set('Authorization', `Bearer ${tokenB}`)
      .send({ windowEnd: new Date(NOW.getTime() + 2 * HOUR).toISOString() });
    expect(editByB.status).toBe(404);
    const listB = await supertest(app.server)
      .get('/v1/me/hosted-visits')
      .set('Authorization', `Bearer ${tokenB}`);
    expect(listB.body.items).toEqual([]);
  });

  it('serves the host detail with timeline and signed photos, and audits the read', async () => {
    const hostelId = await makeHostel(db);
    const hostId = await makeVerifiedHost(db, hostelId);
    await makeGateWithSecret(hostelId);
    const token = await issueToken(clock, { type: 'user', id: hostId });
    const visitId = (await createInvite(token)).body.visit.id;

    const detail = await supertest(app.server)
      .get(`/v1/visits/${visitId}`)
      .set('Authorization', `Bearer ${token}`);
    expect(detail.status).toBe(200);
    expect(detail.body.events.map((e: { kind: string }) => e.kind)).toEqual(['created']);
    const audit = await db
      .selectFrom('haven.audit_log')
      .select(['action', 'entity_id', 'actor_id'])
      .where('action', '=', 'read.visit')
      .executeTakeFirstOrThrow();
    expect(audit).toEqual({ action: 'read.visit', entity_id: visitId, actor_id: hostId });
  });

  it('signed media URLs work for 120 s and are refused when tampered or expired', async () => {
    const hostelId = await makeHostel(db);
    const visitorId = await makeVisitor(db);
    const bytes = await tinyJpeg();
    const row = await db
      .insertInto('haven.media')
      .values({
        kind: 'visitor_profile',
        bucket: 'visitor-photos',
        path: `${visitorId}/p.jpg`,
        sha256: Buffer.from('h'),
        bytes: bytes.length,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await media.put({ bucket: 'visitor-photos', path: `${visitorId}/p.jpg` }, bytes);
    void hostelId;

    const { MediaUrlSigner } = await import('../src/media/signing.js');
    const signer = new MediaUrlSigner(
      Buffer.alloc(32, 1).toString('base64'),
      'http://api.haven.test',
      clock,
    );
    const { url } = signer.sign(row.id);
    const path = url.replace('http://api.haven.test', '');

    const ok = await supertest(app.server).get(path);
    expect(ok.status).toBe(200);
    expect(ok.headers['content-type']).toBe('image/jpeg');
    expect(Buffer.compare(ok.body as Buffer, bytes)).toBe(0);

    expect((await supertest(app.server).get(path.replace(/sig=[^&]+/, 'sig=bogus'))).status).toBe(
      404,
    );
    clock.advance(121_000);
    expect((await supertest(app.server).get(path)).status).toBe(404);
  });
});
