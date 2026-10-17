import type { Kysely, Transaction } from 'kysely';
import {
  evaluateCreate,
  evaluateEntry,
  localDateTimeToUtc,
  monthsTouched,
  nightsBetween,
  quotaUsed,
  RESIDENT_SCREENS,
  type CreateVisitBody,
  type QuotaMonth,
  type VisitPreview,
  type VisitType as RuleVisitType,
} from '@haven/shared';
import type { Database } from '../db/index.js';
import { AppError } from '../lib/errors.js';
import { randomSecret, sha256 } from '../lib/crypto.js';
import { withTx } from '../lib/tx.js';
import type { Principal } from '../auth/principal.js';
import { authorize } from '../auth/policy.js';
import { assertTransition } from './stateMachine.js';
import {
  countHostActiveDayGuests,
  findActiveOvernightBookings,
  findVisitById,
  isVisitorInsideElsewhere,
  updateVisitStatus,
  type VisitRow,
} from './repository.js';
import { isVisitorBanned, loadGuestName, loadHostIdentity, loadHostState } from './context.js';
import { bookingDates, checkIn, type VisitServiceDeps } from './service.js';
import type { VisitActorResource } from './policy.js';
import { enqueueNotification, wardenIdsFor } from '../notify/outbox.js';
import {
  confirmLocationSms,
  confirmLocationText,
  disputeSms,
  disputeText,
  SMS_FALLBACK_DELAY_MS,
} from '../notify/templates.js';
import { consumeScanSession } from '../gate/repository.js';

/**
 * Host actions from SDD §12.6 that aren't a plain §7.1 status transition (or that
 * wrap one with host-specific rules): confirm-arrival, dispute, window edit, invite-
 * link regeneration, preview — plus the guest-side half of F3 that confirm-arrival
 * completes. Each runs in one transaction and calls `authorize()` (CLAUDE.md §3.10).
 */

function resourceFor(
  row: Pick<VisitRow, 'hostel_id' | 'host_id' | 'visitor_id'>,
): VisitActorResource {
  return { hostelId: row.hostel_id, hostUserId: row.host_id, visitorId: row.visitor_id };
}

function throwIfDenied(result: { decision: string; codes: string[] }): void {
  if (result.decision !== 'deny') return;
  const code = result.codes[0] ?? 'INTERNAL';
  if (code === 'ALREADY_INSIDE') {
    throw new AppError('ALREADY_INSIDE', 409, 'This guest is already checked in to another visit.');
  }
  throw new AppError(code, 422, `Not allowed: ${code}.`, { codes: result.codes });
}

function linkFor(deps: VisitServiceDeps, screen: string): string {
  return `${(deps.webBaseUrl ?? 'http://localhost:8081').replace(/\/$/, '')}${screen}`;
}

/** The unconsumed, unexpired scan session a guest's location-unverified check-in left
 * waiting for the host (SDD F3 step 4). */
export async function findPendingConfirmationSession(
  db: Kysely<Database> | Transaction<Database>,
  visitId: string,
) {
  return db
    .selectFrom('haven.scan_sessions')
    .selectAll()
    .where('visit_id', '=', visitId)
    .where('consumed_at', 'is', null)
    .where('gps_ok', '=', false)
    .where('photo_media_id', 'is not', null)
    .orderBy('created_at', 'desc')
    .executeTakeFirst();
}

// ---------------------------------------------------------------------------
// F3: guest's check-in without verified location → wait for the host
// ---------------------------------------------------------------------------

/**
 * SDD §12.8 check-in steps: "evaluateEntry → if gpsOk is false and the visit isn't
 * already host-confirmed, set result = awaiting_host_confirmation, store the photo on
 * the session, notify host (N-CONFIRM-LOCATION), return". The visit stays `approved`;
 * the session is linked to it so the host's confirm-arrival can complete the entry.
 */
export async function requestHostLocationConfirmation(
  deps: VisitServiceDeps,
  params: {
    principal: Principal | null;
    requestId: string;
    visitId: string;
    scanSessionId: string;
    photoMediaId: string;
  },
): Promise<VisitRow> {
  return withTx(
    deps.db,
    { principal: params.principal, requestId: params.requestId },
    async (trx) => {
      const visit = await findVisitById(trx, params.visitId);
      if (!visit) throw new AppError('NOT_FOUND', 404, 'Visit not found.');
      assertTransition(visit.status, 'check_in');
      authorize(params.principal, 'visits.check_in', resourceFor(visit));

      const now = deps.clock.now();
      const result = evaluateEntry(
        {
          now,
          type: visit.type as RuleVisitType,
          host: await loadHostState(trx, visit.host_id),
          visitorBanned: await isVisitorBanned(trx, visit.visitor_id, visit.hostel_id, now),
          visitStatus: visit.status,
          windowStart: visit.window_start,
          windowEnd: visit.window_end,
          visitorAlreadyInsideElsewhere: visit.visitor_id
            ? await isVisitorInsideElsewhere(trx, visit.visitor_id, visit.id)
            : false,
          gpsOk: false,
          hostActiveDayGuestCount: await countHostActiveDayGuests(trx, visit.host_id),
        },
        deps.rulesConfig,
      );
      throwIfDenied(result);

      await trx
        .updateTable('haven.scan_sessions')
        .set({ visit_id: visit.id, photo_media_id: params.photoMediaId })
        .where('id', '=', params.scanSessionId)
        .execute();

      const guestName = await loadGuestName(trx, visit);
      const screen = RESIDENT_SCREENS.arrival(visit.id);
      await enqueueNotification(trx, {
        now,
        hostelId: visit.hostel_id,
        recipient: { type: 'user', userId: visit.host_id },
        kind: 'N-CONFIRM-LOCATION',
        channel: 'push',
        visitId: visit.id,
        screen,
        text: confirmLocationText({ guestName }),
        dedupeKey: `confirm-location:${params.scanSessionId}`,
        sms: {
          text: confirmLocationSms({ guestName, link: linkFor(deps, screen) }),
          delayMs: SMS_FALLBACK_DELAY_MS,
        },
      });
      return visit;
    },
  );
}

// ---------------------------------------------------------------------------
// POST /visits/{id}/confirm-arrival ★
// ---------------------------------------------------------------------------

/**
 * Two cases, both "Host — VisitDTO" in SDD §12.6:
 *  - the guest's check-in is waiting on the host (F3): "For a location-unverified
 *    check-in this performs the entry" — via `checkIn` with the pending scan
 *    session's GPS facts and photo, cut-offs judged at the scan time (E-05);
 *  - the guest is already inside: R-09's "Yes, that's my guest" (FR-42), available
 *    within `dispute_window_minutes` of entry — sets `host_confirmed_at`.
 */
export async function confirmArrival(
  deps: VisitServiceDeps,
  params: { principal: Principal | null; requestId: string; visitId: string },
): Promise<VisitRow> {
  const visit = await deps.db
    .selectFrom('haven.visits')
    .selectAll()
    .where('id', '=', params.visitId)
    .executeTakeFirst();
  if (!visit) throw new AppError('NOT_FOUND', 404, 'Visit not found.');
  authorize(params.principal, 'visits.confirm_arrival', resourceFor(visit));

  if (visit.status === 'approved') {
    const session = await findPendingConfirmationSession(deps.db, visit.id);
    if (!session) {
      throw new AppError('INVALID_TRANSITION', 409, 'Your guest has not asked you to confirm.');
    }
    if (session.expires_at.getTime() <= deps.clock.now().getTime()) {
      // A scan session allows one gate action within 10 minutes (SDD §9.3); after
      // that the guest has to scan the gate QR again.
      throw new AppError(
        'SCAN_SESSION_EXPIRED',
        410,
        'This request expired. Ask your guest to scan again.',
      );
    }
    const updated = await checkIn(deps, {
      principal: params.principal,
      requestId: params.requestId,
      visitId: visit.id,
      gate: {
        gateId: session.gate_id,
        scanSessionId: session.id,
        locationVerified: false,
        distanceM: session.distance_m,
        accuracyM: session.accuracy_m,
        photoMediaId: session.photo_media_id,
      },
      hostConfirmation: { judgedAt: session.created_at },
      onEntered: (trx, entered) =>
        consumeScanSession(trx, session.id, 'check_in', deps.clock.now(), entered.id),
    });
    return updated;
  }

  if (visit.status === 'inside') {
    if (visit.host_confirmed_at) {
      throw new AppError('INVALID_TRANSITION', 409, 'You already confirmed this guest.');
    }
    if (visit.host_disputed_at) {
      throw new AppError('INVALID_TRANSITION', 409, 'You reported this guest as not yours.');
    }
    assertWithinDisputeWindow(deps, visit);
    return withTx(
      deps.db,
      { principal: params.principal, requestId: params.requestId },
      async (trx) => {
        const row = await trx
          .updateTable('haven.visits')
          .set({ host_confirmed_at: deps.clock.now().toISOString(), updated_at: new Date() })
          .where('id', '=', visit.id)
          .where('status', '=', 'inside')
          .where('host_confirmed_at', 'is', null)
          .where('host_disputed_at', 'is', null)
          .returningAll()
          .executeTakeFirst();
        if (!row)
          throw new AppError(
            'INVALID_TRANSITION',
            409,
            'This visit changed. Refresh and try again.',
          );
        return row;
      },
    );
  }

  throw new AppError('INVALID_TRANSITION', 409, 'There is nothing to confirm for this visit.');
}

/** FR-42: "Yes, that's my guest / Not my guest (available for 30 min)". */
function assertWithinDisputeWindow(deps: VisitServiceDeps, visit: VisitRow): void {
  const enteredAt = visit.last_entry_at ?? visit.first_entry_at;
  const windowMs = deps.rulesConfig.dispute_window_minutes * 60_000;
  if (!enteredAt || deps.clock.now().getTime() > enteredAt.getTime() + windowMs) {
    throw new AppError(
      'INVALID_TRANSITION',
      409,
      `This can only be done within ${deps.rulesConfig.dispute_window_minutes} minutes of arrival.`,
    );
  }
}

/**
 * Whether R-09's arrival actions apply: the guest checked themself in (an invite or an
 * overnight stay). Walk-ins and host-assisted entries were approved by the host with
 * the photo in front of them — "Host does not get a separate arrival confirmation"
 * (SDD F2 step 9), so there is no arrival card to dispute.
 */
export function hasArrivalCard(visit: Pick<VisitRow, 'origin'>): boolean {
  return visit.origin === 'invite' || visit.origin === 'overnight_request';
}

// ---------------------------------------------------------------------------
// POST /visits/{id}/dispute ★ (F9)
// ---------------------------------------------------------------------------

export async function disputeArrival(
  deps: VisitServiceDeps,
  params: { principal: Principal | null; requestId: string; visitId: string; note?: string },
): Promise<VisitRow> {
  return withTx(
    deps.db,
    { principal: params.principal, requestId: params.requestId },
    async (trx) => {
      const visit = await findVisitById(trx, params.visitId);
      if (!visit) throw new AppError('NOT_FOUND', 404, 'Visit not found.');
      authorize(params.principal, 'visits.dispute', resourceFor(visit));
      if (visit.status !== 'inside' || !hasArrivalCard(visit)) {
        throw new AppError('INVALID_TRANSITION', 409, 'This guest is not checked in.');
      }
      if (visit.host_disputed_at) {
        throw new AppError('INVALID_TRANSITION', 409, 'You already reported this guest.');
      }
      if (visit.host_confirmed_at) {
        throw new AppError('INVALID_TRANSITION', 409, 'You already confirmed this guest.');
      }
      assertWithinDisputeWindow(deps, visit);

      const now = deps.clock.now();
      // F9 step 2: "Visit gets host_disputed_at; status stays inside (the person is
      // still physically inside)."
      const updated = await trx
        .updateTable('haven.visits')
        .set({ host_disputed_at: now.toISOString(), updated_at: new Date() })
        .where('id', '=', visit.id)
        .where('status', '=', 'inside')
        .where('host_disputed_at', 'is', null)
        .returningAll()
        .executeTakeFirst();
      if (!updated)
        throw new AppError('INVALID_TRANSITION', 409, 'This visit changed. Refresh and try again.');

      const host = await loadHostIdentity(trx, visit.host_id);
      const guestName = await loadGuestName(trx, visit);
      const hostel = await trx
        .selectFrom('haven.hostels')
        .select('code')
        .where('id', '=', visit.hostel_id)
        .executeTakeFirstOrThrow();
      const checkedInAt = visit.last_entry_at ?? visit.first_entry_at ?? now;
      for (const wardenId of await wardenIdsFor(trx, visit.hostel_id)) {
        const screen = `/warden/visits/${visit.id}`;
        // N-DISPUTE: wardens, "Push (alerts) + SMS immediately" (SDD §15.2).
        await enqueueNotification(trx, {
          now,
          hostelId: visit.hostel_id,
          recipient: { type: 'user', userId: wardenId },
          kind: 'N-DISPUTE',
          channel: 'push',
          visitId: visit.id,
          screen,
          text: disputeText({ hostName: host.fullName, room: host.room, guestName, checkedInAt }),
          data: params.note ? { note: params.note } : undefined,
          dedupeKey: `dispute:${visit.id}:${wardenId}`,
          sms: {
            text: disputeSms({ hostelCode: hostel.code, link: linkFor(deps, screen) }),
            delayMs: 0,
          },
        });
      }
      return updated;
    },
  );
}

// ---------------------------------------------------------------------------
// PATCH /visits/{id} — edit the window before entry (FR-13)
// ---------------------------------------------------------------------------

export async function editVisitWindow(
  deps: VisitServiceDeps,
  params: {
    principal: Principal | null;
    requestId: string;
    visitId: string;
    windowStart?: Date;
    windowEnd?: Date;
  },
): Promise<VisitRow> {
  return withTx(
    deps.db,
    { principal: params.principal, requestId: params.requestId },
    async (trx) => {
      const visit = await findVisitById(trx, params.visitId);
      if (!visit) throw new AppError('NOT_FOUND', 404, 'Visit not found.');
      authorize(params.principal, 'visits.edit_window', resourceFor(visit));
      if (!isEditable(visit)) {
        throw new AppError('INVALID_TRANSITION', 409, 'This visit can no longer be changed.');
      }
      const windowStart = params.windowStart ?? visit.window_start;
      const windowEnd = params.windowEnd ?? visit.window_end;
      const hostel = await trx
        .selectFrom('haven.hostels')
        .select('gender_served')
        .where('id', '=', visit.hostel_id)
        .executeTakeFirstOrThrow();
      const result = evaluateCreate(
        {
          now: deps.clock.now(),
          type: visit.type as RuleVisitType,
          hostelGender: hostel.gender_served as 'male' | 'female',
          host: await loadHostState(trx, visit.host_id),
          visitorBanned: await isVisitorBanned(
            trx,
            visit.visitor_id,
            visit.hostel_id,
            deps.clock.now(),
          ),
          guestGender: visit.invited_gender,
          windowStart,
          windowEnd,
          existingOvernightBookings: [],
          hostActiveDayGuestCount: await countHostActiveDayGuests(trx, visit.host_id),
        },
        deps.rulesConfig,
      );
      throwIfDenied(result);
      // Same status in and out — the optimistic guard still rejects a visit that moved
      // (e.g. the guest checked in a moment ago) with 409 (SDD §7.3).
      return updateVisitStatus(trx, {
        id: visit.id,
        expectedStatus: 'approved',
        newStatus: 'approved',
        patch: { windowStart, windowEnd },
      });
    },
  );
}

/** FR-13: "edit the window ... until the guest checks in" — day/quick drop-off invites
 * only (an overnight stay's window comes from its warden-approved dates). */
export function isEditable(visit: Pick<VisitRow, 'status' | 'first_entry_at' | 'type'>): boolean {
  return (
    visit.status === 'approved' &&
    visit.first_entry_at === null &&
    (visit.type === 'day' || visit.type === 'quick_drop')
  );
}

// ---------------------------------------------------------------------------
// POST /visits/{id}/invite-link — new token, old link stops working (SDD §9.6)
// ---------------------------------------------------------------------------

export function canShareInvite(
  visit: Pick<VisitRow, 'status' | 'first_entry_at' | 'origin'>,
): boolean {
  return (
    visit.status === 'approved' &&
    visit.first_entry_at === null &&
    (visit.origin === 'invite' || visit.origin === 'overnight_request')
  );
}

export async function regenerateInviteLink(
  deps: VisitServiceDeps,
  params: { principal: Principal | null; requestId: string; visitId: string },
): Promise<{ visit: VisitRow; inviteToken: string }> {
  return withTx(
    deps.db,
    { principal: params.principal, requestId: params.requestId },
    async (trx) => {
      const visit = await findVisitById(trx, params.visitId);
      if (!visit) throw new AppError('NOT_FOUND', 404, 'Visit not found.');
      authorize(params.principal, 'visits.invite_link', resourceFor(visit));
      if (!canShareInvite(visit)) {
        throw new AppError('INVALID_TRANSITION', 409, 'This visit has no invite to share.');
      }
      const inviteToken = randomSecret(16).toString('base64url');
      const updated = await trx
        .updateTable('haven.visits')
        .set({ invite_token_hash: sha256(inviteToken), updated_at: new Date() })
        .where('id', '=', visit.id)
        .where('status', '=', 'approved')
        .returningAll()
        .executeTakeFirst();
      if (!updated)
        throw new AppError('INVALID_TRANSITION', 409, 'This visit changed. Refresh and try again.');
      return { visit: updated, inviteToken };
    },
  );
}

// ---------------------------------------------------------------------------
// POST /visits/preview — no write (SDD §12.6, F6 step 2)
// ---------------------------------------------------------------------------

/** Overnight windows: arrivalDate at visiting_start → departureDate at overnight_checkout_time (SDD §12.6). */
export function overnightWindow(
  cfg: VisitServiceDeps['rulesConfig'],
  arrivalDate: string,
  departureDate: string,
): { windowStart: Date; windowEnd: Date } {
  return {
    windowStart: localDateTimeToUtc(arrivalDate, cfg.visiting_start, cfg.timezone),
    windowEnd: localDateTimeToUtc(departureDate, cfg.overnight_checkout_time, cfg.timezone),
  };
}

export async function previewVisit(
  deps: VisitServiceDeps,
  params: {
    principal: Principal | null;
    hostUserId: string;
    hostelId: string;
    body: CreateVisitBody;
  },
): Promise<VisitPreview> {
  authorize(params.principal, 'visits.preview', {
    hostelId: params.hostelId,
    hostUserId: params.hostUserId,
    visitorId: null,
  });
  const cfg = deps.rulesConfig;
  return deps.db.transaction().execute(async (trx) => {
    const host = await loadHostState(trx, params.hostUserId);
    const hostel = await trx
      .selectFrom('haven.hostels')
      .select('gender_served')
      .where('id', '=', params.hostelId)
      .executeTakeFirstOrThrow();
    const body = params.body;

    if (body.kind === 'invite') {
      const result = evaluateCreate(
        {
          now: deps.clock.now(),
          type: body.type,
          hostelGender: hostel.gender_served as 'male' | 'female',
          host,
          visitorBanned: false,
          guestGender: body.guest.gender ?? null,
          windowStart: new Date(body.windowStart),
          windowEnd: new Date(body.windowEnd),
          existingOvernightBookings: [],
          hostActiveDayGuestCount: await countHostActiveDayGuests(trx, params.hostUserId),
        },
        cfg,
      );
      return {
        decision: result.decision,
        codes: result.codes,
        zone: result.zone ?? null,
        nights: 0,
        chargeInr: 0,
        quota: [],
      };
    }

    const { windowStart, windowEnd } = overnightWindow(cfg, body.arrivalDate, body.departureDate);
    const bookings = (await findActiveOvernightBookings(trx, params.hostUserId)).map((b) =>
      bookingDates(b, cfg.timezone),
    );
    const nights = nightsBetween(body.arrivalDate, body.departureDate);
    const result = evaluateCreate(
      {
        now: deps.clock.now(),
        type: body.type,
        hostelGender: hostel.gender_served as 'male' | 'female',
        host,
        visitorBanned: false,
        guestGender: body.guest.gender,
        windowStart,
        windowEnd,
        arrivalDate: body.arrivalDate,
        departureDate: body.departureDate,
        existingOvernightBookings: body.type === 'overnight_room' ? bookings : [],
        hostActiveDayGuestCount: 0,
      },
      cfg,
    );
    const perNight =
      body.type === 'overnight_room'
        ? cfg.overnight_room.charge_per_night_inr
        : cfg.guest_room.charge_per_night_inr;
    // Quota only applies to overnight_room (BR-05).
    const quota: QuotaMonth[] =
      body.type === 'overnight_room'
        ? monthsTouched(nights).map((month) => {
            const used = quotaUsed(
              bookings.flatMap((b) => nightsBetween(b.arrivalDate, b.departureDate)),
              month,
            );
            return { month, used, after: used + quotaUsed(nights, month) };
          })
        : [];
    return {
      decision: result.decision,
      codes: result.codes,
      zone: result.zone ?? null,
      nights: nights.length,
      chargeInr: nights.length * perNight,
      quota,
    };
  });
}

// ---------------------------------------------------------------------------
// GET /me/quota
// ---------------------------------------------------------------------------

export async function quotaFor(
  deps: VisitServiceDeps,
  hostUserId: string,
  month: string,
): Promise<{ month: string; used: number; limit: number; remaining: number }> {
  const bookings = await findActiveOvernightBookings(deps.db, hostUserId);
  const nights = bookings.flatMap((b) => {
    const d = bookingDates(b, deps.rulesConfig.timezone);
    return nightsBetween(d.arrivalDate, d.departureDate);
  });
  const used = quotaUsed(nights, month);
  const limit = deps.rulesConfig.overnight_room.max_nights_per_month;
  return { month, used, limit, remaining: Math.max(0, limit - used) };
}
