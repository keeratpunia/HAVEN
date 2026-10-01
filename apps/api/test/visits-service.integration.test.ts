import { beforeEach, describe, expect, it } from 'vitest';
import { GH8_RULES_CONFIG_V1 } from '@haven/shared';
import { getTestDb, resetAllHavenTables } from './db-test-helper.js';
import {
  makeGate,
  makeHostel,
  makeVerifiedHost,
  makeVisitor,
  makeWarden,
} from './visits-fixtures.js';
import { FakeClock } from '../src/lib/clock.js';
import type { Principal } from '../src/auth/principal.js';
import { __resetPolicyRegistryForTests } from '../src/auth/policy.js';
import { registerVisitPolicies, __resetVisitPoliciesForTests } from '../src/visits/policy.js';
import type { VisitServiceDeps } from '../src/visits/service.js';
import {
  approveOvernight,
  approveWalkIn,
  cancelApprovedVisit,
  cancelOvernightRequest,
  cancelWalkIn,
  checkIn,
  checkOut,
  completeApprovedVisitWithoutReturn,
  createHostAssistedEntry,
  createOvernightRequest,
  createPreInvite,
  createWalkIn,
  expireApprovedVisit,
  expireWalkIn,
  hostMarksGuestLeft,
  rejectOvernight,
  rejectWalkIn,
  wardenForcesCheckout,
} from '../src/visits/service.js';

const db = getTestDb();

const NOW = new Date('2026-10-01T05:00:00.000Z'); // 10:30 IST — inside visiting hours
const WINDOW_START = NOW;
const WINDOW_END = new Date(NOW.getTime() + 2 * 60 * 60 * 1000); // 12:30 IST

function deps(clock: FakeClock): VisitServiceDeps {
  return { db, clock, rulesConfig: GH8_RULES_CONFIG_V1, rulesVersion: 1 };
}

function userPrincipal(userId: string): Principal {
  return { type: 'user', userId, sessionId: 'sess-1', roles: [] };
}
function visitorPrincipal(visitorId: string): Principal {
  return { type: 'visitor', visitorId, sessionId: 'sess-2' };
}
function wardenPrincipal(userId: string, hostelId: string): Principal {
  return { type: 'user', userId, sessionId: 'sess-3', roles: [{ h: hostelId, r: 'warden' }] };
}

function gateCtx(gateId: string, overrides: Partial<{ locationVerified: boolean }> = {}) {
  return { gateId, locationVerified: overrides.locationVerified ?? true };
}

let reqCounter = 0;
function reqId(): string {
  reqCounter += 1;
  return `req-${reqCounter}`;
}

beforeEach(async () => {
  await resetAllHavenTables();
  __resetPolicyRegistryForTests();
  __resetVisitPoliciesForTests();
  registerVisitPolicies();
});

describe('createPreInvite ((new) -> approved, SDD §7.1 row 1)', () => {
  it('valid: host creates a day pre-invite, invite token issued', async () => {
    const clock = new FakeClock(NOW);
    const hostelId = await makeHostel(db);
    const hostId = await makeVerifiedHost(db, hostelId);

    const { visit, inviteToken } = await createPreInvite(deps(clock), {
      principal: userPrincipal(hostId),
      requestId: reqId(),
      hostUserId: hostId,
      hostelId,
      hostelGender: 'female',
      type: 'day',
      invitedName: 'Guest One',
      invitedPhone: '+919876500001',
      invitedGender: 'female',
      windowStart: WINDOW_START,
      windowEnd: WINDOW_END,
    });

    expect(visit.status).toBe('approved');
    expect(visit.invite_token_hash).not.toBeNull();
    expect(inviteToken).toMatch(/^[A-Za-z0-9_-]{20,}$/);
  });

  it('rule denial: an unverified host gets HOST_NOT_VERIFIED (422)', async () => {
    const clock = new FakeClock(NOW);
    const hostelId = await makeHostel(db);
    // A user with no residents row at all behaves like "not verified".
    const hostId = (
      await db
        .insertInto('haven.users')
        .values({
          google_sub: 'unverified-sub',
          email: 'unverified@haven.test',
          full_name: 'Unverified',
        })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id;

    await expect(
      createPreInvite(deps(clock), {
        principal: userPrincipal(hostId),
        requestId: reqId(),
        hostUserId: hostId,
        hostelId,
        hostelGender: 'female',
        type: 'day',
        invitedName: 'Guest',
        invitedPhone: '+919876500002',
        invitedGender: 'female',
        windowStart: WINDOW_START,
        windowEnd: WINDOW_END,
      }),
    ).rejects.toMatchObject({ code: 'HOST_NOT_VERIFIED', httpStatus: 422 });
  });

  it('rule denial: a window outside visiting hours is WINDOW_INVALID (422)', async () => {
    const clock = new FakeClock(NOW);
    const hostelId = await makeHostel(db);
    const hostId = await makeVerifiedHost(db, hostelId);
    const midnight = new Date('2026-10-01T19:00:00.000Z'); // 00:30 IST next day — outside 08:00-22:00

    await expect(
      createPreInvite(deps(clock), {
        principal: userPrincipal(hostId),
        requestId: reqId(),
        hostUserId: hostId,
        hostelId,
        hostelGender: 'female',
        type: 'day',
        invitedName: 'Guest',
        invitedPhone: '+919876500003',
        invitedGender: 'female',
        windowStart: midnight,
        windowEnd: new Date(midnight.getTime() + 60 * 60 * 1000),
      }),
    ).rejects.toMatchObject({ code: 'WINDOW_INVALID', httpStatus: 422 });
  });

  it('authorization boundary: a different user cannot create a pre-invite as this host', async () => {
    const clock = new FakeClock(NOW);
    const hostelId = await makeHostel(db);
    const hostId = await makeVerifiedHost(db, hostelId);
    const otherUserId = await makeVerifiedHost(db, hostelId);

    await expect(
      createPreInvite(deps(clock), {
        principal: userPrincipal(otherUserId),
        requestId: reqId(),
        hostUserId: hostId,
        hostelId,
        hostelGender: 'female',
        type: 'day',
        invitedName: 'Guest',
        invitedPhone: '+919876500004',
        invitedGender: 'female',
        windowStart: WINDOW_START,
        windowEnd: WINDOW_END,
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN', httpStatus: 403 });
  });
});

describe('Walk-in lifecycle: (new) -> pending_host -> {inside | rejected | expired | cancelled}', () => {
  async function setUp() {
    const clock = new FakeClock(NOW);
    const hostelId = await makeHostel(db);
    const hostId = await makeVerifiedHost(db, hostelId);
    const visitorId = await makeVisitor(db);
    const gateId = await makeGate(db, hostelId);
    return { clock, hostelId, hostId, visitorId, gateId };
  }

  it('valid: full happy path walk-in approved at the gate (N-WALKIN sent)', async () => {
    const { clock, hostelId, hostId, visitorId, gateId } = await setUp();
    const visit = await createWalkIn(deps(clock), {
      principal: visitorPrincipal(visitorId),
      requestId: reqId(),
      visitorId,
      hostUserId: hostId,
      hostelId,
      hostelGender: 'female',
      type: 'day',
      guestGender: 'female',
      windowStart: WINDOW_START,
      windowEnd: WINDOW_END,
    });
    expect(visit.status).toBe('pending_host');

    const notif = await db
      .selectFrom('haven.notifications')
      .selectAll()
      .where('visit_id', '=', visit.id)
      .where('kind', '=', 'N-WALKIN')
      .executeTakeFirst();
    expect(notif).toBeDefined();

    const approved = await approveWalkIn(deps(clock), {
      principal: userPrincipal(hostId),
      requestId: reqId(),
      visitId: visit.id,
      gate: gateCtx(gateId),
    });
    expect(approved.status).toBe('inside');
    expect(approved.first_entry_at).not.toBeNull();

    const gateEvent = await db
      .selectFrom('haven.gate_events')
      .selectAll()
      .where('visit_id', '=', visit.id)
      .where('kind', '=', 'entry')
      .executeTakeFirst();
    expect(gateEvent).toBeDefined();
  });

  it('valid: host rejects (N-WALKIN-REJECTED sent)', async () => {
    const { clock, hostelId, hostId, visitorId } = await setUp();
    const visit = await createWalkIn(deps(clock), {
      principal: visitorPrincipal(visitorId),
      requestId: reqId(),
      visitorId,
      hostUserId: hostId,
      hostelId,
      hostelGender: 'female',
      type: 'day',
      guestGender: 'female',
      windowStart: WINDOW_START,
      windowEnd: WINDOW_END,
    });
    const rejected = await rejectWalkIn(deps(clock), {
      principal: userPrincipal(hostId),
      requestId: reqId(),
      visitId: visit.id,
    });
    expect(rejected.status).toBe('rejected');
    const notif = await db
      .selectFrom('haven.notifications')
      .selectAll()
      .where('visit_id', '=', visit.id)
      .where('kind', '=', 'N-WALKIN-REJECTED')
      .executeTakeFirst();
    expect(notif).toBeDefined();
  });

  it('valid: 10-minute timeout expires it (system trigger)', async () => {
    const { clock, hostelId, hostId, visitorId } = await setUp();
    const visit = await createWalkIn(deps(clock), {
      principal: visitorPrincipal(visitorId),
      requestId: reqId(),
      visitorId,
      hostUserId: hostId,
      hostelId,
      hostelGender: 'female',
      type: 'day',
      guestGender: 'female',
      windowStart: WINDOW_START,
      windowEnd: WINDOW_END,
    });
    clock.advance(11 * 60 * 1000);
    const expired = await expireWalkIn(deps(clock), { requestId: reqId(), visitId: visit.id });
    expect(expired.status).toBe('expired');
  });

  it('valid: guest cancels', async () => {
    const { clock, hostelId, hostId, visitorId } = await setUp();
    const visit = await createWalkIn(deps(clock), {
      principal: visitorPrincipal(visitorId),
      requestId: reqId(),
      visitorId,
      hostUserId: hostId,
      hostelId,
      hostelGender: 'female',
      type: 'day',
      guestGender: 'female',
      windowStart: WINDOW_START,
      windowEnd: WINDOW_END,
    });
    const cancelled = await cancelWalkIn(deps(clock), {
      principal: visitorPrincipal(visitorId),
      requestId: reqId(),
      visitId: visit.id,
    });
    expect(cancelled.status).toBe('cancelled');
  });

  it('INVALID_TRANSITION: approving an already-rejected walk-in is rejected (409)', async () => {
    const { clock, hostelId, hostId, visitorId, gateId } = await setUp();
    const visit = await createWalkIn(deps(clock), {
      principal: visitorPrincipal(visitorId),
      requestId: reqId(),
      visitorId,
      hostUserId: hostId,
      hostelId,
      hostelGender: 'female',
      type: 'day',
      guestGender: 'female',
      windowStart: WINDOW_START,
      windowEnd: WINDOW_END,
    });
    await rejectWalkIn(deps(clock), {
      principal: userPrincipal(hostId),
      requestId: reqId(),
      visitId: visit.id,
    });

    await expect(
      approveWalkIn(deps(clock), {
        principal: userPrincipal(hostId),
        requestId: reqId(),
        visitId: visit.id,
        gate: gateCtx(gateId),
      }),
    ).rejects.toMatchObject({ code: 'INVALID_TRANSITION', httpStatus: 409 });
  });

  it('authorization boundary: a different host cannot approve this walk-in', async () => {
    const { clock, hostelId, hostId, visitorId, gateId } = await setUp();
    const otherHostId = await makeVerifiedHost(db, hostelId);
    const visit = await createWalkIn(deps(clock), {
      principal: visitorPrincipal(visitorId),
      requestId: reqId(),
      visitorId,
      hostUserId: hostId,
      hostelId,
      hostelGender: 'female',
      type: 'day',
      guestGender: 'female',
      windowStart: WINDOW_START,
      windowEnd: WINDOW_END,
    });

    await expect(
      approveWalkIn(deps(clock), {
        principal: userPrincipal(otherHostId),
        requestId: reqId(),
        visitId: visit.id,
        gate: gateCtx(gateId),
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN', httpStatus: 403 });
  });
});

describe('Overnight request lifecycle: (new) -> pending_warden -> {approved | rejected | cancelled}', () => {
  const arrivalDate = '2026-10-02';
  const departureDate = '2026-10-03';
  const overnightStart = new Date('2026-10-02T02:30:00.000Z'); // 08:00 IST
  const overnightEnd = new Date('2026-10-03T06:30:00.000Z'); // 12:00 IST

  async function setUp() {
    const clock = new FakeClock(NOW);
    const hostelId = await makeHostel(db);
    const hostId = await makeVerifiedHost(db, hostelId);
    const wardenId = await makeWarden(db, hostelId);
    return { clock, hostelId, hostId, wardenId };
  }

  async function createRequest(clock: FakeClock, hostelId: string, hostId: string) {
    return createOvernightRequest(deps(clock), {
      principal: userPrincipal(hostId),
      requestId: reqId(),
      hostUserId: hostId,
      hostelId,
      hostelGender: 'female',
      type: 'overnight_room',
      invitedName: 'Overnight Guest',
      invitedPhone: '+919876500005',
      invitedGender: 'female',
      windowStart: overnightStart,
      windowEnd: overnightEnd,
      arrivalDate,
      departureDate,
      nights: 1,
    });
  }

  it('valid: warden approves — pending charge created, invite token issued, N-OVERNIGHT-DECIDED sent', async () => {
    const { clock, hostelId, hostId, wardenId } = await setUp();
    const visit = await createRequest(clock, hostelId, hostId);
    expect(visit.status).toBe('pending_warden');

    const reqNotif = await db
      .selectFrom('haven.notifications')
      .selectAll()
      .where('visit_id', '=', visit.id)
      .where('kind', '=', 'N-OVERNIGHT-REQ')
      .executeTakeFirst();
    expect(reqNotif).toBeDefined();

    const approved = await approveOvernight(deps(clock), {
      principal: wardenPrincipal(wardenId, hostelId),
      requestId: reqId(),
      visitId: visit.id,
    });
    expect(approved.status).toBe('approved');

    const charge = await db
      .selectFrom('haven.charges')
      .selectAll()
      .where('visit_id', '=', visit.id)
      .executeTakeFirst();
    expect(charge?.status).toBe('pending');
    expect(charge?.amount_inr).toBe(GH8_RULES_CONFIG_V1.overnight_room.charge_per_night_inr);

    const decidedNotif = await db
      .selectFrom('haven.notifications')
      .selectAll()
      .where('visit_id', '=', visit.id)
      .where('kind', '=', 'N-OVERNIGHT-DECIDED')
      .executeTakeFirst();
    expect(decidedNotif).toBeDefined();
  });

  it('valid: warden rejects', async () => {
    const { clock, hostelId, hostId, wardenId } = await setUp();
    const visit = await createRequest(clock, hostelId, hostId);
    const rejected = await rejectOvernight(deps(clock), {
      principal: wardenPrincipal(wardenId, hostelId),
      requestId: reqId(),
      visitId: visit.id,
      reason: 'Quota exceeded for the month',
    });
    expect(rejected.status).toBe('rejected');
  });

  it('valid: host cancels their own pending request', async () => {
    const { clock, hostelId, hostId } = await setUp();
    const visit = await createRequest(clock, hostelId, hostId);
    const cancelled = await cancelOvernightRequest(deps(clock), {
      principal: userPrincipal(hostId),
      requestId: reqId(),
      visitId: visit.id,
    });
    expect(cancelled.status).toBe('cancelled');
  });

  it('rule denial: a 4th night in the month is QUOTA_EXCEEDED (422)', async () => {
    const { clock, hostelId, hostId, wardenId } = await setUp();
    // Burn the 3-night monthly quota with one approved 3-night stay.
    const first = await createOvernightRequest(deps(clock), {
      principal: userPrincipal(hostId),
      requestId: reqId(),
      hostUserId: hostId,
      hostelId,
      hostelGender: 'female',
      type: 'overnight_room',
      invitedName: 'Guest',
      invitedPhone: '+919876500006',
      invitedGender: 'female',
      windowStart: overnightStart,
      windowEnd: new Date('2026-10-05T06:30:00.000Z'),
      arrivalDate: '2026-10-02',
      departureDate: '2026-10-05',
      nights: 3,
    });
    await approveOvernight(deps(clock), {
      principal: wardenPrincipal(wardenId, hostelId),
      requestId: reqId(),
      visitId: first.id,
    });

    await expect(
      createOvernightRequest(deps(clock), {
        principal: userPrincipal(hostId),
        requestId: reqId(),
        hostUserId: hostId,
        hostelId,
        hostelGender: 'female',
        type: 'overnight_room',
        invitedName: 'Guest 2',
        invitedPhone: '+919876500007',
        invitedGender: 'female',
        windowStart: new Date('2026-10-06T02:30:00.000Z'),
        windowEnd: new Date('2026-10-07T06:30:00.000Z'),
        arrivalDate: '2026-10-06',
        departureDate: '2026-10-07',
        nights: 1,
      }),
    ).rejects.toMatchObject({ code: 'QUOTA_EXCEEDED', httpStatus: 422 });
  });

  it('authorization boundary: a non-warden cannot approve an overnight request', async () => {
    const { clock, hostelId, hostId } = await setUp();
    const visit = await createRequest(clock, hostelId, hostId);
    await expect(
      approveOvernight(deps(clock), {
        principal: userPrincipal(hostId),
        requestId: reqId(),
        visitId: visit.id,
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN', httpStatus: 403 });
  });
});

describe('Host-assisted entry: (new) -> inside directly (SDD F4)', () => {
  it('valid: creates a visitor + visit, straight to inside, gate event entry', async () => {
    const clock = new FakeClock(NOW);
    const hostelId = await makeHostel(db);
    const hostId = await makeVerifiedHost(db, hostelId);
    const gateId = await makeGate(db, hostelId);

    const visit = await createHostAssistedEntry(deps(clock), {
      principal: userPrincipal(hostId),
      requestId: reqId(),
      hostUserId: hostId,
      hostelId,
      hostelGender: 'female',
      gateId,
      type: 'day',
      invitedName: 'Phoneless Guest',
      invitedPhone: null,
      invitedGender: 'female',
      windowStart: WINDOW_START,
      windowEnd: WINDOW_END,
    });

    expect(visit.status).toBe('inside');
    expect(visit.visitor_id).not.toBeNull();
    expect(visit.first_entry_at).not.toBeNull();

    const gateEvent = await db
      .selectFrom('haven.gate_events')
      .selectAll()
      .where('visit_id', '=', visit.id)
      .executeTakeFirst();
    expect(gateEvent?.kind).toBe('entry');
  });
});

describe('Approved-visit lifecycle: approved -> {inside | cancelled | expired | completed}', () => {
  async function setUpApproved() {
    const clock = new FakeClock(NOW);
    const hostelId = await makeHostel(db);
    const hostId = await makeVerifiedHost(db, hostelId);
    const visitorId = await makeVisitor(db);
    const gateId = await makeGate(db, hostelId);
    const { visit } = await createPreInvite(deps(clock), {
      principal: userPrincipal(hostId),
      requestId: reqId(),
      hostUserId: hostId,
      hostelId,
      hostelGender: 'female',
      type: 'day',
      invitedName: 'Guest',
      invitedPhone: '+919876500008',
      invitedGender: 'female',
      windowStart: WINDOW_START,
      windowEnd: WINDOW_END,
    });
    // Claim the invite directly at the DB level (invite-claim flow is the auth
    // milestone's `invites.ts`, out of scope here) so the visit has a visitor.
    await db
      .updateTable('haven.visits')
      .set({ visitor_id: visitorId })
      .where('id', '=', visit.id)
      .execute();
    return { clock, hostelId, hostId, visitorId, gateId, visitId: visit.id };
  }

  it('valid: guest checks in at the gate (N-ARRIVED sent)', async () => {
    const { clock, hostId, visitorId, gateId, visitId } = await setUpApproved();
    const checkedIn = await checkIn(deps(clock), {
      principal: visitorPrincipal(visitorId),
      requestId: reqId(),
      visitId,
      gate: gateCtx(gateId),
    });
    expect(checkedIn.status).toBe('inside');

    const notif = await db
      .selectFrom('haven.notifications')
      .selectAll()
      .where('visit_id', '=', visitId)
      .where('kind', '=', 'N-ARRIVED')
      .where('recipient_id', '=', hostId)
      .executeTakeFirst();
    expect(notif).toBeDefined();
  });

  it('valid: host cancels — any pending charge is waived', async () => {
    const { clock, hostId, visitId } = await setUpApproved();
    const cancelled = await cancelApprovedVisit(deps(clock), {
      principal: userPrincipal(hostId),
      requestId: reqId(),
      visitId,
    });
    expect(cancelled.status).toBe('cancelled');
  });

  it('valid: system expires an approved visit nobody entered (charge waived)', async () => {
    const { clock, visitId, hostelId, hostId } = await setUpApproved();
    const resident = await db
      .selectFrom('haven.residents')
      .select('user_id')
      .where('user_id', '=', hostId)
      .executeTakeFirstOrThrow();
    await db
      .insertInto('haven.charges')
      .values({
        hostel_id: hostelId,
        resident_id: resident.user_id,
        visit_id: visitId,
        kind: 'guest_room',
        units: 1,
        unit_price_inr: 150,
        amount_inr: 150,
        description: 'test charge',
      })
      .execute();

    const expired = await expireApprovedVisit(deps(clock), { requestId: reqId(), visitId });
    expect(expired.status).toBe('expired');
    const charge = await db
      .selectFrom('haven.charges')
      .selectAll()
      .where('visit_id', '=', visitId)
      .executeTakeFirstOrThrow();
    expect(charge.status).toBe('waived');
    expect(charge.waive_reason).not.toBeNull();
  });

  it('rule denial: TOO_EARLY check-in before the window is denied (422)', async () => {
    const { clock, visitorId, gateId, visitId } = await setUpApproved();
    clock.set(new Date(WINDOW_START.getTime() - 31 * 60 * 1000)); // 31 min before start
    await expect(
      checkIn(deps(clock), {
        principal: visitorPrincipal(visitorId),
        requestId: reqId(),
        visitId,
        gate: gateCtx(gateId),
      }),
    ).rejects.toMatchObject({ code: 'TOO_EARLY', httpStatus: 422 });
  });

  it('valid: system closes an approved visit as completed after window_end when it had a prior entry (charge confirmed)', async () => {
    const clock = new FakeClock(NOW);
    const hostelId = await makeHostel(db);
    const hostId = await makeVerifiedHost(db, hostelId);
    const wardenId = await makeWarden(db, hostelId);
    const visitorId = await makeVisitor(db);
    const gateId = await makeGate(db, hostelId);

    const overnightStart = new Date('2026-10-02T02:30:00.000Z');
    const overnightEnd = new Date('2026-10-03T06:30:00.000Z');
    const requested = await createOvernightRequest(deps(clock), {
      principal: userPrincipal(hostId),
      requestId: reqId(),
      hostUserId: hostId,
      hostelId,
      hostelGender: 'female',
      type: 'overnight_room',
      invitedName: 'Guest',
      invitedPhone: '+919876500011',
      invitedGender: 'female',
      windowStart: overnightStart,
      windowEnd: overnightEnd,
      arrivalDate: '2026-10-02',
      departureDate: '2026-10-03',
      nights: 1,
    });
    await approveOvernight(deps(clock), {
      principal: wardenPrincipal(wardenId, hostelId),
      requestId: reqId(),
      visitId: requested.id,
    });
    await db
      .updateTable('haven.visits')
      .set({ visitor_id: visitorId })
      .where('id', '=', requested.id)
      .execute();

    clock.set(overnightStart);
    await checkIn(deps(clock), {
      principal: visitorPrincipal(visitorId),
      requestId: reqId(),
      visitId: requested.id,
      gate: gateCtx(gateId),
    });
    // Step out well before window_end -> back to 'approved', and never returns.
    const steppedOut = await checkOut(deps(clock), {
      principal: visitorPrincipal(visitorId),
      requestId: reqId(),
      visitId: requested.id,
      gate: gateCtx(gateId),
    });
    expect(steppedOut.status).toBe('approved');

    clock.set(new Date(overnightEnd.getTime() + 1000));
    const closed = await completeApprovedVisitWithoutReturn(deps(clock), {
      requestId: reqId(),
      visitId: requested.id,
    });
    expect(closed.status).toBe('completed');
    expect(closed.close_reason).toBe('window_ended');

    const charge = await db
      .selectFrom('haven.charges')
      .selectAll()
      .where('visit_id', '=', requested.id)
      .executeTakeFirstOrThrow();
    expect(charge.status).toBe('confirmed');
  });
});

describe('Inside-visit lifecycle: inside -> {approved | completed}', () => {
  async function setUpInside(type: 'day' | 'overnight_room' = 'day') {
    const clock = new FakeClock(NOW);
    const hostelId = await makeHostel(db);
    const hostId = await makeVerifiedHost(db, hostelId);
    const visitorId = await makeVisitor(db);
    const gateId = await makeGate(db, hostelId);
    const wardenId = await makeWarden(db, hostelId);

    let visitId: string;
    if (type === 'day') {
      const { visit } = await createPreInvite(deps(clock), {
        principal: userPrincipal(hostId),
        requestId: reqId(),
        hostUserId: hostId,
        hostelId,
        hostelGender: 'female',
        type: 'day',
        invitedName: 'Guest',
        invitedPhone: '+919876500009',
        invitedGender: 'female',
        windowStart: WINDOW_START,
        windowEnd: WINDOW_END,
      });
      visitId = visit.id;
    } else {
      const visit = await createOvernightRequest(deps(clock), {
        principal: userPrincipal(hostId),
        requestId: reqId(),
        hostUserId: hostId,
        hostelId,
        hostelGender: 'female',
        type: 'overnight_room',
        invitedName: 'Guest',
        invitedPhone: '+919876500010',
        invitedGender: 'female',
        windowStart: new Date('2026-10-02T02:30:00.000Z'),
        windowEnd: new Date('2026-10-03T06:30:00.000Z'),
        arrivalDate: '2026-10-02',
        departureDate: '2026-10-03',
        nights: 1,
      });
      const approved = await approveOvernight(deps(clock), {
        principal: wardenPrincipal(wardenId, hostelId),
        requestId: reqId(),
        visitId: visit.id,
      });
      visitId = approved.id;
      clock.set(new Date('2026-10-02T03:00:00.000Z'));
    }
    await db
      .updateTable('haven.visits')
      .set({ visitor_id: visitorId })
      .where('id', '=', visitId)
      .execute();
    const checkedIn = await checkIn(deps(clock), {
      principal: visitorPrincipal(visitorId),
      requestId: reqId(),
      visitId,
      gate: gateCtx(gateId),
    });
    return { clock, hostelId, hostId, visitorId, gateId, wardenId, visitId: checkedIn.id };
  }

  it('valid: day-guest check-out -> completed (N-LEFT sent, charge confirmed if any)', async () => {
    const { clock, hostId, visitorId, gateId, visitId } = await setUpInside('day');
    const out = await checkOut(deps(clock), {
      principal: visitorPrincipal(visitorId),
      requestId: reqId(),
      visitId,
      gate: gateCtx(gateId),
    });
    expect(out.status).toBe('completed');
    expect(out.close_reason).toBe('checked_out');
    const notif = await db
      .selectFrom('haven.notifications')
      .selectAll()
      .where('visit_id', '=', visitId)
      .where('kind', '=', 'N-LEFT')
      .where('recipient_id', '=', hostId)
      .executeTakeFirst();
    expect(notif).toBeDefined();
  });

  it('valid: overnight guest stepping out well before window_end -> approved (not completed)', async () => {
    const { clock, visitorId, gateId, visitId } = await setUpInside('overnight_room');
    const out = await checkOut(deps(clock), {
      principal: visitorPrincipal(visitorId),
      requestId: reqId(),
      visitId,
      gate: gateCtx(gateId),
    });
    expect(out.status).toBe('approved');
  });

  it('valid: overnight guest checking out within 30 min of window_end -> completed', async () => {
    const { clock, visitorId, gateId, visitId } = await setUpInside('overnight_room');
    const visit = await db
      .selectFrom('haven.visits')
      .selectAll()
      .where('id', '=', visitId)
      .executeTakeFirstOrThrow();
    clock.set(new Date(visit.window_end.getTime() - 10 * 60 * 1000));
    const out = await checkOut(deps(clock), {
      principal: visitorPrincipal(visitorId),
      requestId: reqId(),
      visitId,
      gate: gateCtx(gateId),
    });
    expect(out.status).toBe('completed');
  });

  it('valid: host marks guest left', async () => {
    const { clock, hostId, visitId } = await setUpInside('day');
    const out = await hostMarksGuestLeft(deps(clock), {
      principal: userPrincipal(hostId),
      requestId: reqId(),
      visitId,
    });
    expect(out.status).toBe('completed');
    expect(out.close_reason).toBe('host_marked_left');
  });

  it('valid: warden forces checkout with a reason', async () => {
    const { clock, wardenId, hostelId, visitId } = await setUpInside('day');
    const out = await wardenForcesCheckout(deps(clock), {
      principal: wardenPrincipal(wardenId, hostelId),
      requestId: reqId(),
      visitId,
      reason: 'Overstayed, warden intervention',
    });
    expect(out.status).toBe('completed');
    expect(out.close_reason).toBe('forced');
  });

  it('VALIDATION_FAILED: warden force-checkout requires a non-empty reason', async () => {
    const { clock, wardenId, hostelId, visitId } = await setUpInside('day');
    await expect(
      wardenForcesCheckout(deps(clock), {
        principal: wardenPrincipal(wardenId, hostelId),
        requestId: reqId(),
        visitId,
        reason: '   ',
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED', httpStatus: 400 });
  });

  it('authorization boundary: a non-warden cannot force a checkout', async () => {
    const { clock, hostId, visitId } = await setUpInside('day');
    await expect(
      wardenForcesCheckout(deps(clock), {
        principal: userPrincipal(hostId),
        requestId: reqId(),
        visitId,
        reason: 'nope',
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN', httpStatus: 403 });
  });

  it('INVALID_TRANSITION: checking out twice fails the second time (409)', async () => {
    const { clock, visitorId, gateId, visitId } = await setUpInside('day');
    await checkOut(deps(clock), {
      principal: visitorPrincipal(visitorId),
      requestId: reqId(),
      visitId,
      gate: gateCtx(gateId),
    });
    await expect(
      checkOut(deps(clock), {
        principal: visitorPrincipal(visitorId),
        requestId: reqId(),
        visitId,
        gate: gateCtx(gateId),
      }),
    ).rejects.toMatchObject({ code: 'INVALID_TRANSITION', httpStatus: 409 });
  });
});
