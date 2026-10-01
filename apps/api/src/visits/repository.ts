import type { Transaction } from 'kysely';
import type { Database } from '../db/index.js';
import type {
  Gender,
  VisitOrigin,
  VisitStatusDb,
  VisitType,
  Zone,
  ActorType,
} from '../db/types.js';
import { AppError } from '../lib/errors.js';
import type { VisitStatus } from './stateMachine.js';

/**
 * Visits repository (SDD §7.3): "Every status change uses `UPDATE visits SET status =
 * $new, ... WHERE id = $id AND status = $expected RETURNING *`. Zero rows returned
 * means someone else changed it first: respond 409 INVALID_TRANSITION and let the
 * client refetch." This is the only place that UPDATEs `haven.visits.status` — the
 * service layer never writes the column directly, so this optimistic-concurrency
 * pattern can never accidentally be bypassed by a shortcut elsewhere.
 *
 * BR-15 ("a guest can be inside only one visit at a time") is enforced by the database
 * itself (`visits_one_inside_per_visitor`, a partial unique index on `visitor_id WHERE
 * status = 'inside'`, see `supabase/migrations/20261001000001_init.sql`) — this module
 * only needs to translate that constraint's violation into `409 ALREADY_INSIDE`
 * (SDD §7.3's own wording), not reimplement the invariant in application code where a
 * race could slip through.
 */

const ONE_INSIDE_PER_VISITOR_CONSTRAINT = 'visits_one_inside_per_visitor';

export interface VisitRow {
  id: string;
  code: string;
  hostel_id: string;
  host_id: string;
  visitor_id: string | null;
  invited_name: string | null;
  invited_phone: string | null;
  invited_gender: Gender | null;
  type: VisitType;
  status: VisitStatusDb;
  origin: VisitOrigin;
  zone: Zone;
  window_start: Date;
  window_end: Date;
  nights: number;
  invite_token_hash: Buffer | null;
  rules_version: number;
  location_unverified: boolean;
  exit_location_unverified: boolean;
  overstay_since: Date | null;
  overstay_escalated_at: Date | null;
  host_confirmed_at: Date | null;
  host_disputed_at: Date | null;
  dispute_resolved_at: Date | null;
  dispute_resolved_by: string | null;
  first_entry_at: Date | null;
  last_entry_at: Date | null;
  last_exit_at: Date | null;
  closed_at: Date | null;
  close_reason: 'checked_out' | 'host_marked_left' | 'forced' | 'window_ended' | null;
  cancel_reason: string | null;
  created_by_type: ActorType;
  created_by_id: string | null;
  created_at: Date;
  updated_at: Date;
}

/** True if a Postgres unique-violation (23505) was raised by the named constraint. */
function isUniqueViolationOn(err: unknown, constraint: string): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === '23505' &&
    'constraint' in err &&
    (err as { constraint?: unknown }).constraint === constraint
  );
}

function throwIfAlreadyInside(err: unknown): never {
  if (isUniqueViolationOn(err, ONE_INSIDE_PER_VISITOR_CONSTRAINT)) {
    throw new AppError('ALREADY_INSIDE', 409, 'This guest is already checked in to another visit.');
  }
  throw err;
}

export interface InsertVisitParams {
  code: string;
  hostelId: string;
  hostId: string;
  visitorId: string | null;
  invitedName: string | null;
  invitedPhone: string | null;
  invitedGender: Gender | null;
  type: VisitType;
  status: VisitStatus;
  origin: VisitOrigin;
  zone: Zone;
  windowStart: Date;
  windowEnd: Date;
  nights: number;
  inviteTokenHash: Buffer | null;
  rulesVersion: number;
  createdByType: ActorType;
  createdById: string | null;
  firstEntryAt?: Date | null;
  lastEntryAt?: Date | null;
  locationUnverified?: boolean;
}

/** Creates a new visit row — the "(new) → X" half of SDD §7.1's table. */
export async function insertVisit(
  trx: Transaction<Database>,
  params: InsertVisitParams,
): Promise<VisitRow> {
  try {
    const row = await trx
      .insertInto('haven.visits')
      .values({
        code: params.code,
        hostel_id: params.hostelId,
        host_id: params.hostId,
        visitor_id: params.visitorId,
        invited_name: params.invitedName,
        invited_phone: params.invitedPhone,
        invited_gender: params.invitedGender,
        type: params.type,
        status: params.status,
        origin: params.origin,
        zone: params.zone,
        window_start: params.windowStart.toISOString(),
        window_end: params.windowEnd.toISOString(),
        nights: params.nights,
        invite_token_hash: params.inviteTokenHash,
        rules_version: params.rulesVersion,
        created_by_type: params.createdByType,
        created_by_id: params.createdById,
        first_entry_at: params.firstEntryAt ? params.firstEntryAt.toISOString() : null,
        last_entry_at: params.lastEntryAt ? params.lastEntryAt.toISOString() : null,
        location_unverified: params.locationUnverified ?? false,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return row;
  } catch (err) {
    throwIfAlreadyInside(err);
  }
}

export interface UpdateVisitStatusParams {
  id: string;
  expectedStatus: VisitStatus;
  newStatus: VisitStatus;
  patch?: Partial<{
    visitorId: string | null;
    hostConfirmedAt: Date | null;
    hostDisputedAt: Date | null;
    disputeResolvedAt: Date | null;
    disputeResolvedBy: string | null;
    overstaySince: Date | null;
    firstEntryAt: Date | null;
    lastEntryAt: Date | null;
    lastExitAt: Date | null;
    closedAt: Date | null;
    closeReason: 'checked_out' | 'host_marked_left' | 'forced' | 'window_ended' | null;
    cancelReason: string | null;
    exitLocationUnverified: boolean;
    locationUnverified: boolean;
  }>;
}

/**
 * The single optimistic-concurrency UPDATE every real transition (the 15 non-creation
 * rows of SDD §7.1) goes through. Throws `AppError('INVALID_TRANSITION', 409, ...)`
 * when zero rows match (either the id doesn't exist, or — the interesting case —
 * `status` had already moved away from `expectedStatus` by the time this ran: SDD
 * §7.3's own example is "host approving at the same moment the 10-minute timeout
 * fires: whichever UPDATE commits first wins; the loser gets 409"). Throws
 * `AppError('ALREADY_INSIDE', 409, ...)` if the update would violate the one-
 * inside-per-visitor constraint (transitioning to `'inside'` for a visitor already
 * inside on a different visit).
 */
export async function updateVisitStatus(
  trx: Transaction<Database>,
  params: UpdateVisitStatusParams,
): Promise<VisitRow> {
  const patch = params.patch ?? {};
  try {
    const row = await trx
      .updateTable('haven.visits')
      .set({
        status: params.newStatus,
        updated_at: new Date(),
        ...(patch.visitorId !== undefined ? { visitor_id: patch.visitorId } : {}),
        ...(patch.hostConfirmedAt !== undefined
          ? { host_confirmed_at: patch.hostConfirmedAt?.toISOString() ?? null }
          : {}),
        ...(patch.hostDisputedAt !== undefined
          ? { host_disputed_at: patch.hostDisputedAt?.toISOString() ?? null }
          : {}),
        ...(patch.disputeResolvedAt !== undefined
          ? { dispute_resolved_at: patch.disputeResolvedAt?.toISOString() ?? null }
          : {}),
        ...(patch.disputeResolvedBy !== undefined
          ? { dispute_resolved_by: patch.disputeResolvedBy }
          : {}),
        ...(patch.overstaySince !== undefined
          ? { overstay_since: patch.overstaySince?.toISOString() ?? null }
          : {}),
        ...(patch.firstEntryAt !== undefined
          ? { first_entry_at: patch.firstEntryAt?.toISOString() ?? null }
          : {}),
        ...(patch.lastEntryAt !== undefined
          ? { last_entry_at: patch.lastEntryAt?.toISOString() ?? null }
          : {}),
        ...(patch.lastExitAt !== undefined
          ? { last_exit_at: patch.lastExitAt?.toISOString() ?? null }
          : {}),
        ...(patch.closedAt !== undefined
          ? { closed_at: patch.closedAt?.toISOString() ?? null }
          : {}),
        ...(patch.closeReason !== undefined ? { close_reason: patch.closeReason } : {}),
        ...(patch.cancelReason !== undefined ? { cancel_reason: patch.cancelReason } : {}),
        ...(patch.exitLocationUnverified !== undefined
          ? { exit_location_unverified: patch.exitLocationUnverified }
          : {}),
        ...(patch.locationUnverified !== undefined
          ? { location_unverified: patch.locationUnverified }
          : {}),
      })
      .where('id', '=', params.id)
      .where('status', '=', params.expectedStatus)
      .returningAll()
      .executeTakeFirst();

    if (!row) {
      throw new AppError(
        'INVALID_TRANSITION',
        409,
        'This visit is no longer in the expected state. Refresh and try again.',
        { visitId: params.id, expectedStatus: params.expectedStatus },
      );
    }
    return row;
  } catch (err) {
    if (err instanceof AppError) throw err;
    throwIfAlreadyInside(err);
  }
}

export async function findVisitById(
  trx: Transaction<Database>,
  id: string,
): Promise<VisitRow | undefined> {
  return trx.selectFrom('haven.visits').selectAll().where('id', '=', id).executeTakeFirst();
}

/** Active (approved/inside) overnight_room bookings for a host — for BR-05/BR-06. */
export async function findActiveOvernightBookings(
  trx: Transaction<Database>,
  hostId: string,
): Promise<{ windowStart: Date; windowEnd: Date }[]> {
  const rows = await trx
    .selectFrom('haven.visits')
    .select(['window_start', 'window_end'])
    .where('host_id', '=', hostId)
    .where('type', '=', 'overnight_room')
    .where('status', 'in', ['approved', 'inside'])
    .execute();
  return rows.map((r) => ({ windowStart: r.window_start, windowEnd: r.window_end }));
}

/** Count of this host's day/quick_drop guests currently `inside` — for BR-11. */
export async function countHostActiveDayGuests(
  trx: Transaction<Database>,
  hostId: string,
): Promise<number> {
  const result = await trx
    .selectFrom('haven.visits')
    .select((eb) => eb.fn.countAll<string>().as('n'))
    .where('host_id', '=', hostId)
    .where('type', 'in', ['day', 'quick_drop'])
    .where('status', '=', 'inside')
    .executeTakeFirstOrThrow();
  return Number(result.n);
}

/** True if this visitor is currently `inside` on any visit other than `excludeVisitId`. */
export async function isVisitorInsideElsewhere(
  trx: Transaction<Database>,
  visitorId: string,
  excludeVisitId: string,
): Promise<boolean> {
  const row = await trx
    .selectFrom('haven.visits')
    .select('id')
    .where('visitor_id', '=', visitorId)
    .where('status', '=', 'inside')
    .where('id', '!=', excludeVisitId)
    .executeTakeFirst();
  return row !== undefined;
}

export async function findVisitByInviteTokenHash(
  trx: Transaction<Database>,
  tokenHash: Buffer,
): Promise<VisitRow | undefined> {
  return trx
    .selectFrom('haven.visits')
    .selectAll()
    .where('invite_token_hash', '=', tokenHash)
    .executeTakeFirst();
}
