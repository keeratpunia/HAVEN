import { beforeEach, describe, expect, it } from 'vitest';
import { GH8_RULES_CONFIG_V1 } from '@haven/shared';
import { getTestDb, resetAllHavenTables } from './db-test-helper.js';
import { makeGate, makeHostel, makeVerifiedHost, makeVisitor } from './visits-fixtures.js';
import { FakeClock } from '../src/lib/clock.js';
import type { Principal } from '../src/auth/principal.js';
import { __resetPolicyRegistryForTests } from '../src/auth/policy.js';
import { registerVisitPolicies, __resetVisitPoliciesForTests } from '../src/visits/policy.js';
import type { VisitServiceDeps } from '../src/visits/service.js';
import {
  approveWalkIn,
  cancelWalkIn,
  checkIn,
  checkOut,
  createPreInvite,
  createWalkIn,
  expireWalkIn,
} from '../src/visits/service.js';

/**
 * SDD §7.3 ("Concurrency rules") — the task's explicit focus. These tests don't mock
 * anything: they fire genuinely concurrent requests (via `Promise.allSettled`) against
 * the same real Postgres row/constraint and assert the SDD's documented outcome —
 * "whichever UPDATE commits first wins; the loser gets 409" and "A partial unique
 * index guarantees one inside visit per visitor ... A violation maps to 409
 * ALREADY_INSIDE" — holds under an actual race, not just in single-threaded test order.
 */

const db = getTestDb();
const NOW = new Date('2026-10-01T05:00:00.000Z'); // 10:30 IST
const WINDOW_START = NOW;
const WINDOW_END = new Date(NOW.getTime() + 2 * 60 * 60 * 1000);

function deps(clock: FakeClock): VisitServiceDeps {
  return { db, clock, rulesConfig: GH8_RULES_CONFIG_V1, rulesVersion: 1 };
}
function userPrincipal(userId: string): Principal {
  return { type: 'user', userId, sessionId: 'sess-1', roles: [] };
}
function visitorPrincipal(visitorId: string): Principal {
  return { type: 'visitor', visitorId, sessionId: 'sess-2' };
}
function gateCtx(gateId: string) {
  return { gateId, locationVerified: true };
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

/** Asserts exactly one of two concurrent outcomes succeeded and the other failed with `code`. */
function assertOneWonOneLost(results: PromiseSettledResult<unknown>[], loserCode: string): void {
  const fulfilled = results.filter((r) => r.status === 'fulfilled');
  const rejected = results.filter((r) => r.status === 'rejected');
  expect(fulfilled).toHaveLength(1);
  expect(rejected).toHaveLength(1);
  const err = (rejected[0] as PromiseRejectedResult).reason;
  expect(err).toMatchObject({ code: loserCode });
}

describe('host approval vs. 10-minute timeout racing on the same pending_host visit', () => {
  it('exactly one of {approve, timeout-expire} wins; the loser gets 409 INVALID_TRANSITION', async () => {
    const clock = new FakeClock(NOW);
    const hostelId = await makeHostel(db);
    const hostId = await makeVerifiedHost(db, hostelId);
    const visitorId = await makeVisitor(db);
    const gateId = await makeGate(db, hostelId);

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

    const results = await Promise.allSettled([
      approveWalkIn(deps(clock), {
        principal: userPrincipal(hostId),
        requestId: reqId(),
        visitId: visit.id,
        gate: gateCtx(gateId),
      }),
      expireWalkIn(deps(clock), { requestId: reqId(), visitId: visit.id }),
    ]);

    assertOneWonOneLost(results, 'INVALID_TRANSITION');

    const final = await db
      .selectFrom('haven.visits')
      .selectAll()
      .where('id', '=', visit.id)
      .executeTakeFirstOrThrow();
    expect(['inside', 'expired']).toContain(final.status);
  });
});

describe('duplicate approval: two concurrent host-approve calls on the same walk-in', () => {
  it('exactly one succeeds; the other gets 409 INVALID_TRANSITION, status never double-applies', async () => {
    const clock = new FakeClock(NOW);
    const hostelId = await makeHostel(db);
    const hostId = await makeVerifiedHost(db, hostelId);
    const visitorId = await makeVisitor(db);
    const gateId = await makeGate(db, hostelId);

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

    const results = await Promise.allSettled([
      approveWalkIn(deps(clock), {
        principal: userPrincipal(hostId),
        requestId: reqId(),
        visitId: visit.id,
        gate: gateCtx(gateId),
      }),
      approveWalkIn(deps(clock), {
        principal: userPrincipal(hostId),
        requestId: reqId(),
        visitId: visit.id,
        gate: gateCtx(gateId),
      }),
    ]);

    assertOneWonOneLost(results, 'INVALID_TRANSITION');

    const gateEvents = await db
      .selectFrom('haven.gate_events')
      .selectAll()
      .where('visit_id', '=', visit.id)
      .execute();
    expect(gateEvents).toHaveLength(1);
  });
});

describe('duplicate check-in: two concurrent check-ins on the same approved visit', () => {
  it('exactly one succeeds; the other gets 409, only one entry gate event is written', async () => {
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
      invitedPhone: '+919876511001',
      invitedGender: 'female',
      windowStart: WINDOW_START,
      windowEnd: WINDOW_END,
    });
    await db
      .updateTable('haven.visits')
      .set({ visitor_id: visitorId })
      .where('id', '=', visit.id)
      .execute();

    const results = await Promise.allSettled([
      checkIn(deps(clock), {
        principal: visitorPrincipal(visitorId),
        requestId: reqId(),
        visitId: visit.id,
        gate: gateCtx(gateId),
      }),
      checkIn(deps(clock), {
        principal: visitorPrincipal(visitorId),
        requestId: reqId(),
        visitId: visit.id,
        gate: gateCtx(gateId),
      }),
    ]);

    assertOneWonOneLost(results, 'INVALID_TRANSITION');

    const final = await db
      .selectFrom('haven.visits')
      .selectAll()
      .where('id', '=', visit.id)
      .executeTakeFirstOrThrow();
    expect(final.status).toBe('inside');
    const gateEvents = await db
      .selectFrom('haven.gate_events')
      .selectAll()
      .where('visit_id', '=', visit.id)
      .where('kind', '=', 'entry')
      .execute();
    expect(gateEvents).toHaveLength(1);
  });
});

describe('duplicate check-out: two concurrent check-outs on the same inside visit', () => {
  it('exactly one succeeds; the other gets 409, only one exit gate event is written', async () => {
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
      invitedPhone: '+919876511002',
      invitedGender: 'female',
      windowStart: WINDOW_START,
      windowEnd: WINDOW_END,
    });
    await db
      .updateTable('haven.visits')
      .set({ visitor_id: visitorId })
      .where('id', '=', visit.id)
      .execute();
    await checkIn(deps(clock), {
      principal: visitorPrincipal(visitorId),
      requestId: reqId(),
      visitId: visit.id,
      gate: gateCtx(gateId),
    });

    const results = await Promise.allSettled([
      checkOut(deps(clock), {
        principal: visitorPrincipal(visitorId),
        requestId: reqId(),
        visitId: visit.id,
        gate: gateCtx(gateId),
      }),
      checkOut(deps(clock), {
        principal: visitorPrincipal(visitorId),
        requestId: reqId(),
        visitId: visit.id,
        gate: gateCtx(gateId),
      }),
    ]);

    assertOneWonOneLost(results, 'INVALID_TRANSITION');

    const final = await db
      .selectFrom('haven.visits')
      .selectAll()
      .where('id', '=', visit.id)
      .executeTakeFirstOrThrow();
    expect(final.status).toBe('completed');
    const exits = await db
      .selectFrom('haven.gate_events')
      .selectAll()
      .where('visit_id', '=', visit.id)
      .where('kind', '=', 'exit')
      .execute();
    expect(exits).toHaveLength(1);
  });
});

describe('simultaneous conflicting actions: guest cancels a walk-in while the host approves it', () => {
  it('exactly one of {cancel, approve} wins; the other gets 409 INVALID_TRANSITION', async () => {
    const clock = new FakeClock(NOW);
    const hostelId = await makeHostel(db);
    const hostId = await makeVerifiedHost(db, hostelId);
    const visitorId = await makeVisitor(db);
    const gateId = await makeGate(db, hostelId);

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

    const results = await Promise.allSettled([
      cancelWalkIn(deps(clock), {
        principal: visitorPrincipal(visitorId),
        requestId: reqId(),
        visitId: visit.id,
      }),
      approveWalkIn(deps(clock), {
        principal: userPrincipal(hostId),
        requestId: reqId(),
        visitId: visit.id,
        gate: gateCtx(gateId),
      }),
    ]);

    assertOneWonOneLost(results, 'INVALID_TRANSITION');

    const final = await db
      .selectFrom('haven.visits')
      .selectAll()
      .where('id', '=', visit.id)
      .executeTakeFirstOrThrow();
    expect(['cancelled', 'inside']).toContain(final.status);
  });
});

describe('two visits attempting to make the same visitor "inside" at once (BR-15)', () => {
  it('the DB partial unique index allows only one; the loser gets 409 ALREADY_INSIDE', async () => {
    const clock = new FakeClock(NOW);
    const hostelId = await makeHostel(db);
    const hostA = await makeVerifiedHost(db, hostelId);
    const hostB = await makeVerifiedHost(db, hostelId);
    const visitorId = await makeVisitor(db);
    const gateId = await makeGate(db, hostelId);

    const { visit: visitA } = await createPreInvite(deps(clock), {
      principal: userPrincipal(hostA),
      requestId: reqId(),
      hostUserId: hostA,
      hostelId,
      hostelGender: 'female',
      type: 'day',
      invitedName: 'Guest',
      invitedPhone: '+919876511003',
      invitedGender: 'female',
      windowStart: WINDOW_START,
      windowEnd: WINDOW_END,
    });
    const { visit: visitB } = await createPreInvite(deps(clock), {
      principal: userPrincipal(hostB),
      requestId: reqId(),
      hostUserId: hostB,
      hostelId,
      hostelGender: 'female',
      type: 'day',
      invitedName: 'Guest Again',
      invitedPhone: '+919876511004',
      invitedGender: 'female',
      windowStart: WINDOW_START,
      windowEnd: WINDOW_END,
    });
    // The SAME visitor is on both visits — a real scenario: two different hosts both
    // invited the same guest for an overlapping window.
    await db
      .updateTable('haven.visits')
      .set({ visitor_id: visitorId })
      .where('id', '=', visitA.id)
      .execute();
    await db
      .updateTable('haven.visits')
      .set({ visitor_id: visitorId })
      .where('id', '=', visitB.id)
      .execute();

    const results = await Promise.allSettled([
      checkIn(deps(clock), {
        principal: visitorPrincipal(visitorId),
        requestId: reqId(),
        visitId: visitA.id,
        gate: gateCtx(gateId),
      }),
      checkIn(deps(clock), {
        principal: visitorPrincipal(visitorId),
        requestId: reqId(),
        visitId: visitB.id,
        gate: gateCtx(gateId),
      }),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    // Either evaluateEntry's own ALREADY_INSIDE deny check or the DB's partial unique
    // index can be the one that catches the race, depending on scheduling — both map
    // to the same SDD-specified outcome.
    expect(rejected[0].reason).toMatchObject({ code: 'ALREADY_INSIDE', httpStatus: 409 });

    const insideCount = await db
      .selectFrom('haven.visits')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .where('visitor_id', '=', visitorId)
      .where('status', '=', 'inside')
      .executeTakeFirstOrThrow();
    expect(Number(insideCount.n)).toBe(1);
  });
});

describe('many concurrent duplicate requests (stress the optimistic-concurrency path harder than 2-way)', () => {
  it('10 concurrent check-ins on the same visit: exactly 1 wins, 9 get 409', async () => {
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
      invitedPhone: '+919876511005',
      invitedGender: 'female',
      windowStart: WINDOW_START,
      windowEnd: WINDOW_END,
    });
    await db
      .updateTable('haven.visits')
      .set({ visitor_id: visitorId })
      .where('id', '=', visit.id)
      .execute();

    const attempts = Array.from({ length: 10 }, () =>
      checkIn(deps(clock), {
        principal: visitorPrincipal(visitorId),
        requestId: reqId(),
        visitId: visit.id,
        gate: gateCtx(gateId),
      }),
    );
    const results = await Promise.allSettled(attempts);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(9);
    for (const r of rejected) {
      expect(r.reason).toMatchObject({ code: 'INVALID_TRANSITION', httpStatus: 409 });
    }
  });
});
