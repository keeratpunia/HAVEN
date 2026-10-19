import type { Kysely, Transaction } from 'kysely';
import {
  evaluateCreate,
  evaluateEntry,
  evaluateExit,
  type CreateContext,
  type EntryContext,
  type ExitContext,
  type Gender as RuleGender,
  type RuleResult,
  type RulesConfig,
  type VisitType as RuleVisitType,
} from '@haven/shared';
import type { Database } from '../db/index.js';
import type { Gender, VisitType, Zone } from '../db/types.js';
import { AppError } from '../lib/errors.js';
import type { Clock } from '../lib/clock.js';
import { generateVisitCode } from '../lib/ids.js';
import { randomSecret, sha256 } from '../lib/crypto.js';
import { withTx } from '../lib/tx.js';
import type { Principal } from '../auth/principal.js';
import { authorize } from '../auth/policy.js';
import type { VisitActorResource } from './policy.js';
import { assertTransition, type VisitTrigger } from './stateMachine.js';
import {
  countHostActiveDayGuests,
  findActiveOvernightBookings,
  findVisitById,
  insertVisit,
  isVisitorInsideElsewhere,
  updateVisitStatus,
  type VisitRow,
} from './repository.js';
import { loadGuestName, loadHostIdentity, loadHostState, isVisitorBanned } from './context.js';
import {
  confirmChargeForVisit,
  createPendingCharge,
  insertGateEvent,
  waiveChargeForVisit,
} from './sideEffects.js';
import { enqueueNotification, wardenIdsFor } from '../notify/outbox.js';
import {
  arrivedText,
  chargeText,
  confirmLocationSms,
  confirmLocationText,
  leftText,
  overnightDecidedText,
  overnightRequestText,
  SMS_FALLBACK_DELAY_MS,
  walkInSms,
  walkInText,
} from '../notify/templates.js';
import { firstName, RESIDENT_SCREENS, toLocalDateString } from '@haven/shared';

/**
 * The visits service: one function per SDD §7.1 trigger, each following the exact
 * sequence the task specifies — (1) validate current state via `stateMachine.ts`'s
 * `assertTransition`, (2) `authorize()`, (3) business rules via the shared rules
 * engine, (4) the atomic optimistic-concurrency state change
 * (`repository.updateVisitStatus`/`insertVisit`), (5) audit (automatic — the
 * `audit_row()` trigger reads the actor context `withTx` sets), (6) gate events where
 * SDD §7.1 names one, (7) notifications where SDD §7.1 names one, (8) returning the
 * updated row. Every mutation runs inside `withTx` so 4-7 are one transaction (SDD §7:
 * "inside one database transaction that also writes the gate event and audit row").
 */

export interface VisitServiceDeps {
  db: Kysely<Database>;
  clock: Clock;
  rulesConfig: RulesConfig;
  rulesVersion: number;
  /** Prefix for links inside SMS bodies (SDD §15.3's `Open HAVEN: {link}`). */
  webBaseUrl?: string;
}

function linkFor(deps: VisitServiceDeps, screen: string): string {
  return `${(deps.webBaseUrl ?? 'http://localhost:8081').replace(/\/$/, '')}${screen}`;
}

async function recordApproval(
  trx: Transaction<Database>,
  p: {
    visitId: string;
    principal: Principal | null;
    role: 'host' | 'warden';
    decision: 'approved' | 'rejected';
    reason?: string | null;
    adjustedWindowEnd?: Date | null;
  },
): Promise<void> {
  if (p.principal?.type !== 'user') return;
  // `approvals` is insert-only with one row per (visit, approver_role) — the decision
  // that moved the visit, shown in the R-10/W-05 timeline (SDD E-09).
  await trx
    .insertInto('haven.approvals')
    .values({
      visit_id: p.visitId,
      approver_id: p.principal.userId,
      approver_role: p.role,
      decision: p.decision,
      reason: p.reason ?? null,
      adjusted_window_end: p.adjustedWindowEnd ? p.adjustedWindowEnd.toISOString() : null,
    })
    .execute();
}

function toCreateContext(
  deps: VisitServiceDeps,
  params: {
    type: VisitType;
    hostelGender: 'male' | 'female';
    host: Awaited<ReturnType<typeof loadHostState>>;
    visitorBanned: boolean;
    guestGender: Gender | null;
    windowStart: Date;
    windowEnd: Date;
    arrivalDate?: string;
    departureDate?: string;
    existingOvernightBookings: { arrivalDate: string; departureDate: string }[];
    hostActiveDayGuestCount: number;
  },
): CreateContext {
  return {
    now: deps.clock.now(),
    type: params.type as RuleVisitType,
    hostelGender: params.hostelGender,
    host: params.host,
    visitorBanned: params.visitorBanned,
    guestGender: params.guestGender as RuleGender | null,
    windowStart: params.windowStart,
    windowEnd: params.windowEnd,
    arrivalDate: params.arrivalDate,
    departureDate: params.departureDate,
    existingOvernightBookings: params.existingOvernightBookings,
    hostActiveDayGuestCount: params.hostActiveDayGuestCount,
  };
}

/** An overnight booking's hostel-local arrival/departure dates, for BR-05/BR-06. */
export function bookingDates(
  b: { windowStart: Date; windowEnd: Date },
  timezone: string,
): { arrivalDate: string; departureDate: string } {
  return {
    arrivalDate: toLocalDateString(b.windowStart, timezone),
    departureDate: toLocalDateString(b.windowEnd, timezone),
  };
}

/** SDD §12.2: `ALREADY_INSIDE` is its own 409 line; every other rules-engine deny is 422. */
function throwIfDenied(result: RuleResult): void {
  if (result.decision !== 'deny') return;
  const code = result.codes[0];
  if (!code) throw new AppError('INTERNAL', 500, 'Rules engine denied with no code.');
  if (code === 'ALREADY_INSIDE') {
    throw new AppError('ALREADY_INSIDE', 409, 'This guest is already checked in to another visit.');
  }
  throw new AppError(code, 422, `Not allowed: ${code}.`, { codes: result.codes });
}

function resourceFor(
  row: Pick<VisitRow, 'hostel_id' | 'host_id' | 'visitor_id'>,
  systemTriggered = false,
): VisitActorResource {
  return {
    hostelId: row.hostel_id,
    hostUserId: row.host_id,
    visitorId: row.visitor_id,
    systemTriggered,
  };
}

// ---------------------------------------------------------------------------
// Creation triggers: (new) -> X
// ---------------------------------------------------------------------------

export interface CreatePreInviteParams {
  principal: Principal | null;
  requestId: string;
  hostUserId: string;
  hostelId: string;
  hostelGender: 'male' | 'female';
  type: 'day' | 'quick_drop';
  invitedName: string;
  invitedPhone: string | null;
  invitedGender: Gender | null;
  windowStart: Date;
  windowEnd: Date;
}

/** (new) -> approved, trigger `pre_invite_created` (SDD §7.1 row 1). */
export async function createPreInvite(
  deps: VisitServiceDeps,
  params: CreatePreInviteParams,
): Promise<{ visit: VisitRow; inviteToken: string }> {
  const transition = assertTransition('new', 'pre_invite_created');
  authorize(params.principal, 'visits.pre_invite_created', {
    hostelId: params.hostelId,
    hostUserId: params.hostUserId,
    visitorId: null,
  });

  return withTx(
    deps.db,
    { principal: params.principal, requestId: params.requestId },
    async (trx) => {
      const host = await loadHostState(trx, params.hostUserId);
      const hostActiveDayGuestCount = await countHostActiveDayGuests(trx, params.hostUserId);
      const result = evaluateCreate(
        toCreateContext(deps, {
          type: params.type,
          hostelGender: params.hostelGender,
          host,
          visitorBanned: false,
          guestGender: params.invitedGender,
          windowStart: params.windowStart,
          windowEnd: params.windowEnd,
          existingOvernightBookings: [],
          hostActiveDayGuestCount,
        }),
        deps.rulesConfig,
      );
      throwIfDenied(result);

      const inviteToken = randomSecret(16).toString('base64url');
      const visit = await insertVisit(trx, {
        code: generateVisitCode(),
        hostelId: params.hostelId,
        hostId: params.hostUserId,
        visitorId: null,
        invitedName: params.invitedName,
        invitedPhone: params.invitedPhone,
        invitedGender: params.invitedGender,
        type: params.type,
        status: transition.to,
        origin: 'invite',
        zone: (result.zone ?? 'visitors_room') as Zone,
        windowStart: params.windowStart,
        windowEnd: params.windowEnd,
        nights: 0,
        inviteTokenHash: sha256(inviteToken),
        rulesVersion: deps.rulesVersion,
        createdByType: 'user',
        createdById: params.hostUserId,
      });

      return { visit, inviteToken };
    },
  );
}

export interface CreateWalkInParams {
  principal: Principal | null;
  requestId: string;
  visitorId: string;
  hostUserId: string;
  hostelId: string;
  hostelGender: 'male' | 'female';
  type: 'day' | 'quick_drop';
  guestGender: Gender | null;
  windowStart: Date;
  windowEnd: Date;
  /** The walk-in scan session's GPS result. False → the host gets N-CONFIRM-LOCATION
   * ("Check-in or walk-in with unverified location", SDD §15.2) instead of N-WALKIN;
   * approving then doubles as the location confirmation (SDD F3 step 4). */
  locationVerified?: boolean;
}

/** (new) -> pending_host, trigger `walk_in_requested` (SDD §7.1 row 2): N-WALKIN to host. */
export async function createWalkIn(
  deps: VisitServiceDeps,
  params: CreateWalkInParams,
): Promise<VisitRow> {
  const transition = assertTransition('new', 'walk_in_requested');
  authorize(params.principal, 'visits.walk_in_requested', {
    hostelId: params.hostelId,
    hostUserId: params.hostUserId,
    visitorId: params.visitorId,
  });

  return withTx(
    deps.db,
    { principal: params.principal, requestId: params.requestId },
    async (trx) => {
      const host = await loadHostState(trx, params.hostUserId);
      const visitorBanned = await isVisitorBanned(
        trx,
        params.visitorId,
        params.hostelId,
        deps.clock.now(),
      );
      const hostActiveDayGuestCount = await countHostActiveDayGuests(trx, params.hostUserId);
      // BR-02/BR-03: a walk-in is an entry at the gate, so the entry cut-offs apply when
      // it is requested — judged now, the moment of the scan (SDD F2, E-05). Checked
      // before the window rules so a late guest hears "the hostel is closed" (§13.6)
      // rather than a window error (FINAL-QA-REPORT D-01).
      throwIfDenied(
        evaluateEntry(
          {
            now: deps.clock.now(),
            type: params.type as RuleVisitType,
            host,
            visitorBanned,
            visitStatus: 'approved',
            windowStart: params.windowStart,
            windowEnd: params.windowEnd,
            visitorAlreadyInsideElsewhere: false,
            gpsOk: params.locationVerified ?? true,
            hostActiveDayGuestCount,
          },
          deps.rulesConfig,
        ),
      );
      const result = evaluateCreate(
        toCreateContext(deps, {
          type: params.type,
          hostelGender: params.hostelGender,
          host,
          visitorBanned,
          guestGender: params.guestGender,
          windowStart: params.windowStart,
          windowEnd: params.windowEnd,
          existingOvernightBookings: [],
          hostActiveDayGuestCount,
        }),
        deps.rulesConfig,
      );
      throwIfDenied(result);

      const visit = await insertVisit(trx, {
        code: generateVisitCode(),
        hostelId: params.hostelId,
        hostId: params.hostUserId,
        visitorId: params.visitorId,
        invitedName: null,
        invitedPhone: null,
        invitedGender: params.guestGender,
        type: params.type,
        status: transition.to,
        origin: 'walk_in',
        zone: (result.zone ?? 'visitors_room') as Zone,
        windowStart: params.windowStart,
        windowEnd: params.windowEnd,
        nights: 0,
        inviteTokenHash: null,
        rulesVersion: deps.rulesVersion,
        createdByType: 'visitor',
        createdById: params.visitorId,
      });

      const guestName = await loadGuestName(trx, visit);
      const screen = RESIDENT_SCREENS.walkIn(visit.id);
      const verified = params.locationVerified ?? true;
      await enqueueNotification(trx, {
        now: deps.clock.now(),
        hostelId: params.hostelId,
        recipient: { type: 'user', userId: params.hostUserId },
        kind: verified ? 'N-WALKIN' : 'N-CONFIRM-LOCATION',
        channel: 'push',
        visitId: visit.id,
        screen,
        text: verified
          ? walkInText({
              guestName,
              type: params.type,
              durationMinutes: (params.windowEnd.getTime() - params.windowStart.getTime()) / 60_000,
            })
          : confirmLocationText({ guestName }),
        dedupeKey: `walkin:${visit.id}`,
        sms: {
          text: verified
            ? walkInSms({ guestName, link: linkFor(deps, screen) })
            : confirmLocationSms({ guestName, link: linkFor(deps, screen) }),
          delayMs: SMS_FALLBACK_DELAY_MS,
        },
      });

      return visit;
    },
  );
}

export interface CreateOvernightRequestParams {
  principal: Principal | null;
  requestId: string;
  hostUserId: string;
  hostelId: string;
  hostelGender: 'male' | 'female';
  type: 'overnight_room' | 'guest_room';
  invitedName: string;
  invitedPhone: string;
  invitedGender: Gender | null;
  windowStart: Date;
  windowEnd: Date;
  arrivalDate: string;
  departureDate: string;
  nights: number;
}

/** (new) -> pending_warden, trigger `overnight_requested` (SDD §7.1 row 3): N-OVERNIGHT-REQ to warden. */
export async function createOvernightRequest(
  deps: VisitServiceDeps,
  params: CreateOvernightRequestParams,
): Promise<VisitRow> {
  const transition = assertTransition('new', 'overnight_requested');
  authorize(params.principal, 'visits.overnight_requested', {
    hostelId: params.hostelId,
    hostUserId: params.hostUserId,
    visitorId: null,
  });

  return withTx(
    deps.db,
    { principal: params.principal, requestId: params.requestId },
    async (trx) => {
      const host = await loadHostState(trx, params.hostUserId);
      const existingOvernightBookings = await findActiveOvernightBookings(trx, params.hostUserId);
      const result = evaluateCreate(
        toCreateContext(deps, {
          type: params.type,
          hostelGender: params.hostelGender,
          host,
          visitorBanned: false,
          guestGender: params.invitedGender,
          windowStart: params.windowStart,
          windowEnd: params.windowEnd,
          arrivalDate: params.arrivalDate,
          departureDate: params.departureDate,
          existingOvernightBookings: existingOvernightBookings.map((b) =>
            bookingDates(b, deps.rulesConfig.timezone),
          ),
          hostActiveDayGuestCount: 0,
        }),
        deps.rulesConfig,
      );
      throwIfDenied(result);

      const visit = await insertVisit(trx, {
        code: generateVisitCode(),
        hostelId: params.hostelId,
        hostId: params.hostUserId,
        visitorId: null,
        invitedName: params.invitedName,
        invitedPhone: params.invitedPhone,
        invitedGender: params.invitedGender,
        type: params.type,
        status: transition.to,
        origin: 'overnight_request',
        zone: (result.zone ?? 'room') as Zone,
        windowStart: params.windowStart,
        windowEnd: params.windowEnd,
        nights: params.nights,
        inviteTokenHash: null,
        rulesVersion: deps.rulesVersion,
        createdByType: 'user',
        createdById: params.hostUserId,
      });

      const hostIdentity = await loadHostIdentity(trx, params.hostUserId);
      for (const wardenId of await wardenIdsFor(trx, params.hostelId)) {
        await enqueueNotification(trx, {
          now: deps.clock.now(),
          hostelId: params.hostelId,
          recipient: { type: 'user', userId: wardenId },
          kind: 'N-OVERNIGHT-REQ',
          channel: 'push',
          visitId: visit.id,
          text: overnightRequestText({
            hostName: hostIdentity.fullName,
            room: hostIdentity.room,
            nights: params.nights,
            guestName: params.invitedName,
          }),
          dedupeKey: `overnight-req:${visit.id}:${wardenId}`,
        });
      }

      return visit;
    },
  );
}

export interface HostAssistedEntryParams {
  principal: Principal | null;
  requestId: string;
  hostUserId: string;
  hostelId: string;
  hostelGender: 'male' | 'female';
  gateId: string;
  type: VisitType;
  invitedName: string;
  invitedPhone: string | null;
  invitedGender: Gender;
  windowStart: Date;
  windowEnd: Date;
  photoMediaId?: string | null;
  /** The host's scan session GPS facts (SDD F4 step 2). Defaults to verified. */
  scanSessionId?: string | null;
  locationVerified?: boolean;
  distanceM?: number | null;
  accuracyM?: number | null;
}

/**
 * (new) -> inside, trigger `host_assisted_entry` (SDD §7.1 row 4): gate event entry.
 * SDD §4.5 runs `evaluateEntry` for "gate check-in, host-assisted entry" — so the
 * cut-offs (BR-02/BR-03) apply here exactly as at a guest's own check-in.
 */
export async function createHostAssistedEntry(
  deps: VisitServiceDeps,
  params: HostAssistedEntryParams,
): Promise<VisitRow> {
  const transition = assertTransition('new', 'host_assisted_entry');
  authorize(params.principal, 'visits.host_assisted_entry', {
    hostelId: params.hostelId,
    hostUserId: params.hostUserId,
    visitorId: null,
  });

  return withTx(
    deps.db,
    { principal: params.principal, requestId: params.requestId },
    async (trx) => {
      const host = await loadHostState(trx, params.hostUserId);
      const hostActiveDayGuestCount = await countHostActiveDayGuests(trx, params.hostUserId);
      const result = evaluateCreate(
        toCreateContext(deps, {
          type: params.type,
          hostelGender: params.hostelGender,
          host,
          visitorBanned: false,
          guestGender: params.invitedGender,
          windowStart: params.windowStart,
          windowEnd: params.windowEnd,
          existingOvernightBookings: [],
          hostActiveDayGuestCount,
        }),
        deps.rulesConfig,
      );
      throwIfDenied(result);

      const locationVerified = params.locationVerified ?? true;
      const entryResult = evaluateEntry(
        {
          now: deps.clock.now(),
          type: params.type as RuleVisitType,
          host,
          visitorBanned: false,
          // The visit is created and admitted in one step; there is no earlier
          // approval state to check (SDD §7.1 row 4: "(new) → inside").
          visitStatus: 'approved',
          windowStart: params.windowStart,
          windowEnd: params.windowEnd,
          visitorAlreadyInsideElsewhere: false,
          gpsOk: locationVerified,
          hostActiveDayGuestCount,
        },
        deps.rulesConfig,
      );
      throwIfDenied(entryResult);

      // Host-assisted guests may have no phone — matched by host + name (SDD F4), a new
      // visitor row every time (no dedupe across host-assisted visits in this milestone).
      const visitor = await trx
        .insertInto('haven.visitors')
        .values({
          phone: params.invitedPhone,
          full_name: params.invitedName,
          gender: params.invitedGender,
          created_by_host_id: params.hostUserId,
          last_visit_at: deps.clock.now().toISOString(),
        })
        .returning('id')
        .executeTakeFirstOrThrow();

      const now = deps.clock.now();
      const visit = await insertVisit(trx, {
        code: generateVisitCode(),
        hostelId: params.hostelId,
        hostId: params.hostUserId,
        visitorId: visitor.id,
        invitedName: params.invitedName,
        invitedPhone: params.invitedPhone,
        invitedGender: params.invitedGender,
        type: params.type,
        status: transition.to,
        origin: 'host_assisted',
        zone: (result.zone ?? 'visitors_room') as Zone,
        windowStart: params.windowStart,
        windowEnd: params.windowEnd,
        nights: 0,
        inviteTokenHash: null,
        rulesVersion: deps.rulesVersion,
        createdByType: 'user',
        createdById: params.hostUserId,
        firstEntryAt: now,
        lastEntryAt: now,
        locationUnverified: !locationVerified,
      });

      await insertGateEvent(trx, {
        at: now,
        visitId: visit.id,
        hostelId: params.hostelId,
        gateId: params.gateId,
        scanSessionId: params.scanSessionId,
        kind: 'entry',
        actorType: 'user',
        actorId: params.hostUserId,
        locationVerified,
        distanceM: params.distanceM,
        accuracyM: params.accuracyM,
        ruleCodes: entryResult.codes,
        photoMediaId: params.photoMediaId,
      });

      return visit;
    },
  );
}

// ---------------------------------------------------------------------------
// Shared helper for the 15 real (from -> to) update transitions.
// ---------------------------------------------------------------------------

async function runTransition<TExtra>(
  deps: VisitServiceDeps,
  params: { principal: Principal | null; requestId: string; visitId: string },
  trigger: VisitTrigger,
  systemTriggered: boolean,
  body: (trx: Transaction<Database>, visit: VisitRow) => Promise<TExtra>,
): Promise<{ visit: VisitRow; extra: TExtra }> {
  return withTx(
    deps.db,
    { principal: params.principal, requestId: params.requestId },
    async (trx) => {
      const current = await findVisitById(trx, params.visitId);
      if (!current) {
        throw new AppError('NOT_FOUND', 404, 'Visit not found.');
      }
      const transition = assertTransition(current.status, trigger);
      authorize(params.principal, `visits.${trigger}`, resourceFor(current, systemTriggered));

      const extra = await body(trx, current);

      const visit = await updateVisitStatus(trx, {
        id: params.visitId,
        expectedStatus: transition.from as VisitRow['status'],
        newStatus: transition.to,
      });
      return { visit, extra };
    },
  );
}

// ---------------------------------------------------------------------------
// pending_host -> X
// ---------------------------------------------------------------------------

export interface WalkInGateContext {
  gateId: string;
  scanSessionId?: string | null;
  /** When the guest scanned (the walk-in scan session's created_at): entry cut-offs
   * are judged at this moment, not at approval (SDD E-05, F2 step 9). */
  judgedAt?: Date | null;
  locationVerified: boolean;
  distanceM?: number | null;
  accuracyM?: number | null;
  photoMediaId?: string | null;
}

/**
 * pending_host -> inside, trigger `host_approves_walk_in` (SDD §7.1 row 5). The guest
 * is already physically at the gate for a walk-in (that's what the "walk-in scan
 * session" the SDD mentions captured) — this is the host's approval *of* that
 * presence, not a second gate-rules evaluation of a pre-approved visit the way
 * `check_in` is. `evaluateEntry` is scoped to visits that already reached `approved`
 * (its own `EntryContext.visitStatus` union doesn't even include `'pending_host'`); a
 * walk-in never passes through `approved` at all (SDD §7.1), so calling it here would
 * always deny with `VISIT_NOT_APPROVED` — a bug this comment exists to stop from being
 * reintroduced, not a real rule. The checks that still matter are re-run here:
 * `evaluateCreate` on the (possibly host-adjusted, R-08 "editable end time") window —
 * BR-11's host day-guest limit is enforced at "Create + approval" — plus the ban and
 * already-inside-elsewhere checks.
 */
export async function approveWalkIn(
  deps: VisitServiceDeps,
  params: {
    principal: Principal | null;
    requestId: string;
    visitId: string;
    gate: WalkInGateContext;
    /** R-08 / SDD §12.6 `{ windowEnd? }`: the host may shorten or extend the stay. */
    windowEnd?: Date;
  },
): Promise<VisitRow> {
  return withTx(
    deps.db,
    { principal: params.principal, requestId: params.requestId },
    async (trx) => {
      const current = await findVisitById(trx, params.visitId);
      if (!current) throw new AppError('NOT_FOUND', 404, 'Visit not found.');
      const transition = assertTransition(current.status, 'host_approves_walk_in');
      authorize(params.principal, 'visits.host_approves_walk_in', resourceFor(current));

      const visitorBanned = await isVisitorBanned(
        trx,
        current.visitor_id,
        current.hostel_id,
        deps.clock.now(),
      );
      const windowEnd = params.windowEnd ?? current.window_end;
      const visitor = current.visitor_id
        ? await trx
            .selectFrom('haven.visitors')
            .select('gender')
            .where('id', '=', current.visitor_id)
            .executeTakeFirst()
        : undefined;
      const hostelGender = (
        await trx
          .selectFrom('haven.hostels')
          .select('gender_served')
          .where('id', '=', current.hostel_id)
          .executeTakeFirstOrThrow()
      ).gender_served as 'male' | 'female';
      const createResult = evaluateCreate(
        toCreateContext(deps, {
          type: current.type,
          hostelGender,
          host: await loadHostState(trx, current.host_id),
          visitorBanned,
          guestGender: visitor?.gender ?? current.invited_gender,
          windowStart: current.window_start,
          windowEnd,
          existingOvernightBookings: [],
          hostActiveDayGuestCount: await countHostActiveDayGuests(trx, current.host_id),
        }),
        deps.rulesConfig,
      );
      throwIfDenied(createResult);

      const visitorAlreadyInsideElsewhere = current.visitor_id
        ? await isVisitorInsideElsewhere(trx, current.visitor_id, current.id)
        : false;
      if (visitorAlreadyInsideElsewhere) {
        throw new AppError(
          'ALREADY_INSIDE',
          409,
          'This guest is already checked in to another visit.',
        );
      }

      // F2 step 9: "server runs evaluateEntry using the scan session's GPS result";
      // E-05: "entry cut-offs are judged at the scan session's created_at" — a walk-in
      // requested at 19:58 and approved at 20:03 is allowed (FINAL-QA-REPORT D-01).
      throwIfDenied(
        evaluateEntry(
          {
            // No scan session (e.g. a seeded request): judged at approval, by our clock.
            now: params.gate.judgedAt ?? deps.clock.now(),
            type: current.type as RuleVisitType,
            host: await loadHostState(trx, current.host_id),
            visitorBanned,
            visitStatus: 'approved',
            windowStart: current.window_start,
            windowEnd,
            visitorAlreadyInsideElsewhere: false,
            gpsOk: params.gate.locationVerified,
            hostActiveDayGuestCount: await countHostActiveDayGuests(trx, current.host_id),
          },
          deps.rulesConfig,
        ),
      );

      const now = deps.clock.now();
      const updated = await updateVisitStatus(trx, {
        id: current.id,
        expectedStatus: transition.from as VisitRow['status'],
        newStatus: transition.to,
        patch: {
          firstEntryAt: current.first_entry_at ?? now,
          lastEntryAt: now,
          locationUnverified: !params.gate.locationVerified,
          ...(params.windowEnd ? { windowEnd } : {}),
          // SDD F3 step 4: "For walk-ins, approval doubles as confirmation."
          hostConfirmedAt: now,
        },
      });
      await recordApproval(trx, {
        visitId: updated.id,
        principal: params.principal,
        role: 'host',
        decision: 'approved',
        adjustedWindowEnd: params.windowEnd ?? null,
      });

      await insertGateEvent(trx, {
        at: now,
        visitId: updated.id,
        hostelId: updated.hostel_id,
        gateId: params.gate.gateId,
        scanSessionId: params.gate.scanSessionId,
        kind: 'entry',
        actorType: 'user',
        actorId: updated.host_id,
        locationVerified: params.gate.locationVerified,
        distanceM: params.gate.distanceM,
        accuracyM: params.gate.accuracyM,
        photoMediaId: params.gate.photoMediaId,
      });

      return updated;
    },
  );
}

/** pending_host -> rejected, trigger `host_rejects_walk_in` (SDD §7.1 row 6): N-WALKIN-REJECTED to guest. */
export async function rejectWalkIn(
  deps: VisitServiceDeps,
  params: { principal: Principal | null; requestId: string; visitId: string; reason?: string },
): Promise<VisitRow> {
  const { visit } = await runTransition(
    deps,
    params,
    'host_rejects_walk_in',
    false,
    async (trx, current) => {
      await recordApproval(trx, {
        visitId: current.id,
        principal: params.principal,
        role: 'host',
        decision: 'rejected',
        reason: params.reason ?? null,
      });
      if (current.visitor_id) {
        // §7.1 "N-WALKIN-REJECTED to guest page"; text is §13.6's "Walk-in rejected" moment.
        const host = await loadHostIdentity(trx, current.host_id);
        await enqueueNotification(trx, {
          now: deps.clock.now(),
          hostelId: current.hostel_id,
          recipient: { type: 'visitor', visitorId: current.visitor_id },
          kind: 'N-WALKIN-REJECTED',
          channel: 'in_app',
          visitId: current.id,
          text: {
            title: `${firstName(host.fullName)} couldn't approve this visit`,
            body: 'Please contact your host directly.',
          },
        });
      }
    },
  );
  return visit;
}

/** pending_host -> expired, trigger `walk_in_timeout` (SDD §7.1 row 7). System-only (a scheduled job). */
export async function expireWalkIn(
  deps: VisitServiceDeps,
  params: { requestId: string; visitId: string },
): Promise<VisitRow> {
  const { visit } = await runTransition(
    deps,
    { principal: null, requestId: params.requestId, visitId: params.visitId },
    'walk_in_timeout',
    true,
    async () => {},
  );
  return visit;
}

/** pending_host -> cancelled, trigger `guest_cancels_walk_in` (SDD §7.1 row 8). */
export async function cancelWalkIn(
  deps: VisitServiceDeps,
  params: { principal: Principal | null; requestId: string; visitId: string },
): Promise<VisitRow> {
  const { visit } = await runTransition(
    deps,
    params,
    'guest_cancels_walk_in',
    false,
    async () => {},
  );
  return visit;
}

// ---------------------------------------------------------------------------
// pending_warden -> X
// ---------------------------------------------------------------------------

/** pending_warden -> approved, trigger `warden_approves_overnight` (SDD §7.1 row 9). */
export async function approveOvernight(
  deps: VisitServiceDeps,
  params: { principal: Principal | null; requestId: string; visitId: string },
): Promise<VisitRow> {
  const { visit } = await runTransition(
    deps,
    params,
    'warden_approves_overnight',
    false,
    async (trx, current) => {
      const chargePerNight =
        current.type === 'overnight_room'
          ? deps.rulesConfig.overnight_room.charge_per_night_inr
          : deps.rulesConfig.guest_room.charge_per_night_inr;
      if (current.nights > 0) {
        const description = `${current.type === 'overnight_room' ? 'Overnight room' : 'Guest room'} stay, ${current.nights} night(s).`;
        const charge = await createPendingCharge(trx, {
          hostelId: current.hostel_id,
          residentId: current.host_id,
          visitId: current.id,
          kind: current.type === 'overnight_room' ? 'overnight_room' : 'guest_room',
          units: current.nights,
          unitPriceInr: chargePerNight,
          description,
          createdBy: params.principal?.type === 'user' ? params.principal.userId : null,
        });
        // N-CHARGE (§15.2): "Charge created or marked paid" → resident, in-app.
        await enqueueNotification(trx, {
          now: deps.clock.now(),
          hostelId: current.hostel_id,
          recipient: { type: 'user', userId: current.host_id },
          kind: 'N-CHARGE',
          channel: 'in_app',
          text: chargeText({ amountInr: charge.amountInr, description, status: 'pending' }),
          dedupeKey: `charge:${charge.id}:created`,
        });
      }
      await recordApproval(trx, {
        visitId: current.id,
        principal: params.principal,
        role: 'warden',
        decision: 'approved',
      });
      await enqueueNotification(trx, {
        now: deps.clock.now(),
        hostelId: current.hostel_id,
        recipient: { type: 'user', userId: current.host_id },
        kind: 'N-OVERNIGHT-DECIDED',
        channel: 'push',
        visitId: current.id,
        text: overnightDecidedText({
          decision: 'approved',
          guestName: await loadGuestName(trx, current),
        }),
        dedupeKey: `overnight-decided:${current.id}`,
      });
    },
  );
  return visit;
}

/** pending_warden -> rejected, trigger `warden_rejects_overnight` (SDD §7.1 row 10). */
export async function rejectOvernight(
  deps: VisitServiceDeps,
  params: { principal: Principal | null; requestId: string; visitId: string; reason?: string },
): Promise<VisitRow> {
  const { visit } = await runTransition(
    deps,
    params,
    'warden_rejects_overnight',
    false,
    async (trx, current) => {
      // SDD §12.6: `{ reason }` is required when a warden rejects.
      const reason = params.reason?.trim();
      if (!reason) {
        throw new AppError('VALIDATION_FAILED', 400, 'A reason is required to decline a request.');
      }
      await recordApproval(trx, {
        visitId: current.id,
        principal: params.principal,
        role: 'warden',
        decision: 'rejected',
        reason,
      });
      await enqueueNotification(trx, {
        now: deps.clock.now(),
        hostelId: current.hostel_id,
        recipient: { type: 'user', userId: current.host_id },
        kind: 'N-OVERNIGHT-DECIDED',
        channel: 'push',
        visitId: current.id,
        text: overnightDecidedText({ decision: 'rejected', reason }),
        dedupeKey: `overnight-decided:${current.id}`,
      });
    },
  );
  return visit;
}

/** pending_warden -> cancelled, trigger `host_cancels_overnight_request` (SDD §7.1 row 11). */
export async function cancelOvernightRequest(
  deps: VisitServiceDeps,
  params: { principal: Principal | null; requestId: string; visitId: string },
): Promise<VisitRow> {
  const { visit } = await runTransition(
    deps,
    params,
    'host_cancels_overnight_request',
    false,
    async () => {},
  );
  return visit;
}

// ---------------------------------------------------------------------------
// approved -> X
// ---------------------------------------------------------------------------

export interface CheckInGateContext {
  gateId: string;
  scanSessionId?: string | null;
  locationVerified: boolean;
  distanceM?: number | null;
  accuracyM?: number | null;
  photoMediaId?: string | null;
}

/**
 * approved -> inside, trigger `check_in` (SDD §7.1 row 12): gate event entry; N-ARRIVED
 * to host. One transaction for the status change, the gate event, the entry
 * timestamps and the notification (SDD §8.2 step 3).
 *
 * `hostConfirmation` is the location-unverified path completed by the host's Confirm
 * (SDD F3 step 4, `POST /visits/{id}/confirm-arrival`): the entry is judged at the scan
 * session's time (SDD E-05: "entry cut-offs are judged at the scan session's
 * created_at, not approval time"), `host_confirmed_at` is set, and no N-ARRIVED is
 * sent — the host is the one who just confirmed (like a walk-in approval, F2 step 9).
 */
export async function checkIn(
  deps: VisitServiceDeps,
  params: {
    principal: Principal | null;
    requestId: string;
    visitId: string;
    gate: CheckInGateContext;
    hostConfirmation?: { judgedAt: Date };
    /** Runs inside the same transaction after the entry is written (e.g. consuming the
     * scan session — SDD §9.3: "consumed_at is set in the same transaction"). */
    onEntered?: (trx: Transaction<Database>, visit: VisitRow) => Promise<void>;
  },
): Promise<VisitRow> {
  return withTx(
    deps.db,
    { principal: params.principal, requestId: params.requestId },
    async (trx) => {
      const current = await findVisitById(trx, params.visitId);
      if (!current) throw new AppError('NOT_FOUND', 404, 'Visit not found.');
      const transition = assertTransition(current.status, 'check_in');
      authorize(params.principal, 'visits.check_in', resourceFor(current));

      const host = await loadHostState(trx, current.host_id);
      const visitorAlreadyInsideElsewhere = current.visitor_id
        ? await isVisitorInsideElsewhere(trx, current.visitor_id, current.id)
        : false;
      const now = deps.clock.now();
      const visitorBanned = await isVisitorBanned(trx, current.visitor_id, current.hostel_id, now);
      const hostActiveDayGuestCount = await countHostActiveDayGuests(trx, current.host_id);
      const entryCtx: EntryContext = {
        now: params.hostConfirmation?.judgedAt ?? now,
        type: current.type as RuleVisitType,
        host,
        visitorBanned,
        visitStatus: current.status,
        windowStart: current.window_start,
        windowEnd: current.window_end,
        visitorAlreadyInsideElsewhere,
        gpsOk: params.gate.locationVerified,
        hostActiveDayGuestCount,
      };
      const result = evaluateEntry(entryCtx, deps.rulesConfig);
      throwIfDenied(result);

      const updated = await updateVisitStatus(trx, {
        id: current.id,
        expectedStatus: transition.from as VisitRow['status'],
        newStatus: transition.to,
        patch: {
          firstEntryAt: current.first_entry_at ?? now,
          lastEntryAt: now,
          locationUnverified: !params.gate.locationVerified,
          ...(params.hostConfirmation ? { hostConfirmedAt: now } : {}),
        },
      });

      await insertGateEvent(trx, {
        at: now,
        visitId: updated.id,
        hostelId: updated.hostel_id,
        gateId: params.gate.gateId,
        scanSessionId: params.gate.scanSessionId,
        kind: 'entry',
        actorType: params.principal?.type === 'visitor' ? 'visitor' : 'user',
        actorId:
          params.principal?.type === 'visitor' ? params.principal.visitorId : updated.host_id,
        locationVerified: params.gate.locationVerified,
        distanceM: params.gate.distanceM,
        accuracyM: params.gate.accuracyM,
        ruleCodes: result.codes,
        photoMediaId: params.gate.photoMediaId,
      });

      if (!params.hostConfirmation) {
        await enqueueNotification(trx, {
          now,
          hostelId: updated.hostel_id,
          recipient: { type: 'user', userId: updated.host_id },
          kind: 'N-ARRIVED',
          channel: 'push',
          visitId: updated.id,
          screen: RESIDENT_SCREENS.arrival(updated.id),
          text: arrivedText({ guestName: await loadGuestName(trx, updated), at: now }),
          dedupeKey: `arrived:${updated.id}:${now.toISOString()}`,
        });
      }
      await params.onEntered?.(trx, updated);
      return updated;
    },
  );
}

/** approved -> cancelled, trigger `cancel_approved` (SDD §7.1 row 13): charge (if any) waived. */
export async function cancelApprovedVisit(
  deps: VisitServiceDeps,
  params: {
    principal: Principal | null;
    requestId: string;
    visitId: string;
    reason?: string;
    systemTriggered?: boolean;
  },
): Promise<VisitRow> {
  const { visit } = await runTransition(
    deps,
    params,
    'cancel_approved',
    params.systemTriggered ?? false,
    async (trx, current) => {
      await waiveChargeForVisit(
        trx,
        current.id,
        deps.clock,
        params.principal?.type === 'user' ? params.principal.userId : null,
      );
    },
  );
  if (params.reason) {
    return withTx(deps.db, { principal: params.principal, requestId: params.requestId }, (trx) =>
      trx
        .updateTable('haven.visits')
        .set({ cancel_reason: params.reason })
        .where('id', '=', visit.id)
        .returningAll()
        .executeTakeFirstOrThrow(),
    );
  }
  return visit;
}

/** approved -> expired, trigger `window_expired_no_entry` (SDD §7.1 row 14). System-only. Charge waived. */
export async function expireApprovedVisit(
  deps: VisitServiceDeps,
  params: { requestId: string; visitId: string },
): Promise<VisitRow> {
  const { visit } = await runTransition(
    deps,
    { principal: null, requestId: params.requestId, visitId: params.visitId },
    'window_expired_no_entry',
    true,
    async (trx, current) => {
      await waiveChargeForVisit(trx, current.id, deps.clock, null);
    },
  );
  return visit;
}

/** approved -> completed, trigger `window_ended_after_entry` (SDD §7.1 row 15). System-only. Charge recalculated. */
export async function completeApprovedVisitWithoutReturn(
  deps: VisitServiceDeps,
  params: { requestId: string; visitId: string },
): Promise<VisitRow> {
  const { visit } = await runTransition(
    deps,
    { principal: null, requestId: params.requestId, visitId: params.visitId },
    'window_ended_after_entry',
    true,
    async (trx, current) => {
      await confirmChargeForVisit(trx, current.id, deps.clock, null);
    },
  );
  return withTx(deps.db, { principal: null, requestId: params.requestId }, (trx) =>
    trx
      .updateTable('haven.visits')
      .set({ closed_at: deps.clock.now().toISOString(), close_reason: 'window_ended' })
      .where('id', '=', visit.id)
      .returningAll()
      .executeTakeFirstOrThrow(),
  );
}

// ---------------------------------------------------------------------------
// inside -> X
// ---------------------------------------------------------------------------

export interface CheckOutGateContext {
  gateId: string;
  scanSessionId?: string | null;
  locationVerified: boolean;
  distanceM?: number | null;
  accuracyM?: number | null;
  photoMediaId?: string | null;
}

/**
 * inside -> approved (stepping out) or inside -> completed (final check-out), trigger
 * `check_out_step_out`/`check_out_final` (SDD §7.1 rows 16-17, SDD F5): the target
 * state depends on `type` and whether `now < window_end - 30min` for overnight/guest-
 * room stays — this decision belongs to the service, not the (never-denying)
 * `evaluateExit`.
 */
export async function checkOut(
  deps: VisitServiceDeps,
  params: {
    principal: Principal | null;
    requestId: string;
    visitId: string;
    gate: CheckOutGateContext;
  },
): Promise<VisitRow> {
  return withTx(
    deps.db,
    { principal: params.principal, requestId: params.requestId },
    async (trx) => {
      const current = await findVisitById(trx, params.visitId);
      if (!current) throw new AppError('NOT_FOUND', 404, 'Visit not found.');

      const stepsOut =
        (current.type === 'overnight_room' || current.type === 'guest_room') &&
        deps.clock.now().getTime() < current.window_end.getTime() - 30 * 60_000;
      const trigger: VisitTrigger = stepsOut ? 'check_out_step_out' : 'check_out_final';

      const transition = assertTransition(current.status, trigger);
      authorize(params.principal, `visits.${trigger}`, resourceFor(current));

      const exitCtx: ExitContext = {
        now: deps.clock.now(),
        windowEnd: current.window_end,
        gpsOk: params.gate.locationVerified,
      };
      const result = evaluateExit(exitCtx, deps.rulesConfig);

      await insertGateEvent(trx, {
        at: deps.clock.now(),
        visitId: current.id,
        hostelId: current.hostel_id,
        gateId: params.gate.gateId,
        scanSessionId: params.gate.scanSessionId,
        kind: 'exit',
        actorType: params.principal?.type === 'visitor' ? 'visitor' : 'user',
        actorId:
          params.principal?.type === 'visitor' ? params.principal.visitorId : current.host_id,
        locationVerified: params.gate.locationVerified,
        distanceM: params.gate.distanceM,
        accuracyM: params.gate.accuracyM,
        ruleCodes: result.codes,
        photoMediaId: params.gate.photoMediaId,
      });

      const now = deps.clock.now();
      const updated = await updateVisitStatus(trx, {
        id: current.id,
        expectedStatus: transition.from as VisitRow['status'],
        newStatus: transition.to,
        patch: {
          lastExitAt: now,
          exitLocationUnverified: !params.gate.locationVerified,
          ...(trigger === 'check_out_final' ? { closedAt: now, closeReason: 'checked_out' } : {}),
        },
      });

      if (trigger === 'check_out_final') {
        await confirmChargeForVisit(trx, current.id, deps.clock, null);
      }
      // F5 step 4: "Host gets N-LEFT" — unless the host did the check-out themself
      // (host-assisted exit, F4 step 5), when telling them would be noise.
      const hostDidIt =
        params.principal?.type === 'user' && params.principal.userId === updated.host_id;
      if (!hostDidIt) {
        await enqueueNotification(trx, {
          now,
          hostelId: updated.hostel_id,
          recipient: { type: 'user', userId: updated.host_id },
          kind: 'N-LEFT',
          channel: 'push',
          visitId: updated.id,
          text: leftText({
            guestName: await loadGuestName(trx, updated),
            at: now,
            locationVerified: params.gate.locationVerified,
          }),
          dedupeKey: `left:${updated.id}:${now.toISOString()}`,
        });
      }

      return updated;
    },
  );
}

/** inside -> completed, trigger `host_marks_guest_left` (SDD §7.1 row 18): close_reason=host_marked_left, flagged. */
export async function hostMarksGuestLeft(
  deps: VisitServiceDeps,
  params: { principal: Principal | null; requestId: string; visitId: string },
): Promise<VisitRow> {
  return withTx(
    deps.db,
    { principal: params.principal, requestId: params.requestId },
    async (trx) => {
      const current = await findVisitById(trx, params.visitId);
      if (!current) throw new AppError('NOT_FOUND', 404, 'Visit not found.');
      const transition = assertTransition(current.status, 'host_marks_guest_left');
      authorize(params.principal, 'visits.host_marks_guest_left', resourceFor(current));

      const now = deps.clock.now();
      const updated = await updateVisitStatus(trx, {
        id: current.id,
        expectedStatus: transition.from as VisitRow['status'],
        newStatus: transition.to,
        patch: { closedAt: now, closeReason: 'host_marked_left' },
      });
      await confirmChargeForVisit(trx, current.id, deps.clock, null);
      return updated;
    },
  );
}

/** inside -> completed, trigger `warden_forces_checkout` (SDD §7.1 row 19): close_reason=forced, reason required. */
export async function wardenForcesCheckout(
  deps: VisitServiceDeps,
  params: { principal: Principal | null; requestId: string; visitId: string; reason: string },
): Promise<VisitRow> {
  if (!params.reason.trim()) {
    throw new AppError('VALIDATION_FAILED', 400, 'A reason is required to force a check-out.');
  }
  return withTx(
    deps.db,
    { principal: params.principal, requestId: params.requestId },
    async (trx) => {
      const current = await findVisitById(trx, params.visitId);
      if (!current) throw new AppError('NOT_FOUND', 404, 'Visit not found.');
      const transition = assertTransition(current.status, 'warden_forces_checkout');
      authorize(params.principal, 'visits.warden_forces_checkout', resourceFor(current));

      const now = deps.clock.now();
      const updated = await updateVisitStatus(trx, {
        id: current.id,
        expectedStatus: transition.from as VisitRow['status'],
        newStatus: transition.to,
        patch: { closedAt: now, closeReason: 'forced', cancelReason: params.reason },
      });
      await confirmChargeForVisit(
        trx,
        current.id,
        deps.clock,
        params.principal?.type === 'user' ? params.principal.userId : null,
      );
      return updated;
    },
  );
}
