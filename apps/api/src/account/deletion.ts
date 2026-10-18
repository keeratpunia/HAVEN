import type { Kysely, Transaction } from 'kysely';
import type { Database } from '../db/index.js';
import type { Clock } from '../lib/clock.js';
import type { Logger } from '../lib/logger.js';
import type { MediaStorage } from '../gate/media.js';
import { withTx } from '../lib/tx.js';
import { cancelFutureVisits } from '../admin/effects.js';
import { purgeDueMedia } from '../jobs/media-purge.js';

/**
 * Account deletion (FR-09, SDD §16.6):
 *   1. The request is recorded and the person is signed out everywhere (the route).
 *   2. A guest inside right now, or with a visit in the next 24 h, waits until that
 *      visit ends. A resident whose guest is inside or due in the next 24 h waits the
 *      same way (docs/DECISIONS.md DEC-015).
 *   3. The worker then deletes their photos, anonymises the visitors/users row as in
 *      §16.5, revokes sessions and push tokens, and cancels approved visits that
 *      haven't started. Visit rows stay, so the host's accountability record survives.
 *   4. Residents with unpaid charges can't delete until the office clears them.
 * The worker runs every 15 minutes, well inside §16.6's "within 7 days".
 */

export type Subject = { type: 'user'; id: string } | { type: 'visitor'; id: string };
export type WaitingFor = 'inside' | 'upcoming_visit' | 'unpaid_charges';

/** §16.6 step 2: "a visit in the next 24 h". */
export const UPCOMING_WINDOW_MS = 24 * 3_600_000;
/** Visit states that are still "a visit" for step 2 (not closed, not refused). */
const OPEN_STATES = ['pending_host', 'pending_warden', 'approved'] as const;

export interface Blockers {
  waitingFor: WaitingFor | null;
  /** When the blocking visit ends, if known (shown to the person). */
  waitUntil: Date | null;
  unpaidInr: number;
}

type Db = Kysely<Database> | Transaction<Database>;

/** Charges a resident still owes: anything the office hasn't marked paid or waived. */
export async function unpaidChargesInr(db: Db, userId: string): Promise<number> {
  const row = await db
    .selectFrom('haven.charges')
    .select((eb) => eb.fn.coalesce(eb.fn.sum<string>('amount_inr'), eb.val('0')).as('total'))
    .where('resident_id', '=', userId)
    .where('status', 'in', ['pending', 'confirmed'])
    .executeTakeFirstOrThrow();
  return Number(row.total);
}

export async function blockersFor(db: Db, subject: Subject, now: Date): Promise<Blockers> {
  const unpaidInr = subject.type === 'user' ? await unpaidChargesInr(db, subject.id) : 0;
  const side = subject.type === 'visitor' ? 'visitor_id' : 'host_id';

  const inside = await db
    .selectFrom('haven.visits')
    .select('window_end')
    .where(side, '=', subject.id)
    .where('status', '=', 'inside')
    .orderBy('window_end', 'desc')
    .executeTakeFirst();
  if (inside) return { waitingFor: 'inside', waitUntil: inside.window_end, unpaidInr };

  const upcoming = await db
    .selectFrom('haven.visits')
    .select('window_end')
    .where(side, '=', subject.id)
    .where('status', 'in', [...OPEN_STATES])
    .where('window_start', '<=', new Date(now.getTime() + UPCOMING_WINDOW_MS))
    .where('window_end', '>', now)
    .orderBy('window_end', 'desc')
    .executeTakeFirst();
  if (upcoming) return { waitingFor: 'upcoming_visit', waitUntil: upcoming.window_end, unpaidInr };

  if (unpaidInr > 0) return { waitingFor: 'unpaid_charges', waitUntil: null, unpaidInr };
  return { waitingFor: null, waitUntil: null, unpaidInr };
}

/** Revokes every live session and push token of the person (§16.6 steps 1 and 3). */
export async function signOutEverywhere(
  trx: Transaction<Database>,
  subject: Subject,
  now: Date,
  reason: string,
): Promise<string[]> {
  const sessions = await trx
    .updateTable('haven.sessions')
    .set({ revoked_at: now.toISOString(), revoke_reason: reason })
    .where('principal_type', '=', subject.type)
    .where('principal_id', '=', subject.id)
    .where('revoked_at', 'is', null)
    .returning('id')
    .execute();
  if (subject.type === 'user') {
    await trx
      .updateTable('haven.push_tokens')
      .set({ disabled_at: now })
      .where('user_id', '=', subject.id)
      .where('disabled_at', 'is', null)
      .execute();
  }
  return sessions.map((s) => s.id);
}

async function audit(
  trx: Transaction<Database>,
  subject: Subject,
  action: string,
  entityId: string,
  detail: Record<string, unknown>,
): Promise<void> {
  await trx
    .insertInto('haven.audit_log')
    .values({
      actor_type: 'system',
      actor_id: null,
      hostel_id: null,
      action,
      entity: 'deletion_requests',
      entity_id: entityId,
      before: null,
      after: JSON.stringify({ subjectType: subject.type, ...detail }),
    })
    .execute();
}

/**
 * Completes one request whose blockers are clear. Photos are marked due now and the
 * files deleted right after commit; a crash in between leaves them due, and the hourly
 * media purge finishes the job.
 */
async function complete(
  db: Kysely<Database>,
  clock: Clock,
  request: { id: string; subject: Subject },
): Promise<void> {
  const now = clock.now();
  const { subject } = request;
  await withTx(db, { principal: null, requestId: `deletion:${request.id}` }, async (trx) => {
    const owner = subject.type === 'user' ? 'owner_user_id' : 'owner_visitor_id';
    await trx
      .updateTable('haven.media')
      .set({ delete_after: now.toISOString() })
      .where(owner, '=', subject.id)
      .where('deleted_at', 'is', null)
      .execute();

    if (subject.type === 'visitor') {
      await cancelFutureVisits(trx, {
        where: { visitorId: subject.id, hostelId: null },
        reason: 'guest deleted their account',
        clock,
        actorUserId: null,
      });
      // As §16.5's guest-identity rule.
      await trx
        .updateTable('haven.visitors')
        .set({ full_name: 'Former guest', phone: null, anonymised_at: now.toISOString() })
        .where('id', '=', subject.id)
        .execute();
    } else {
      await cancelFutureVisits(trx, {
        where: { hostId: subject.id },
        reason: 'host deleted their account',
        clock,
        actorUserId: null,
      });
      await trx
        .updateTable('haven.residents')
        .set({ status: 'left' })
        .where('user_id', '=', subject.id)
        .where('status', '!=', 'left')
        .execute();
      // §16.5 has no resident row; the same rule as a guest's, with the identifiers a
      // user row must keep unique replaced (DEC-015).
      await trx
        .updateTable('haven.users')
        .set({
          full_name: 'Former resident',
          email: `deleted-${subject.id}@deleted.invalid`,
          google_sub: `deleted:${subject.id}`,
          phone: null,
          phone_verified_at: null,
          is_active: false,
          anonymised_at: now.toISOString(),
        })
        .where('id', '=', subject.id)
        .execute();
    }

    await signOutEverywhere(trx, subject, now, 'account deleted');
    await trx
      .updateTable('haven.deletion_requests')
      .set({
        status: 'completed',
        waiting_for: null,
        completed_at: now.toISOString(),
        checked_at: now.toISOString(),
      })
      .where('id', '=', request.id)
      .execute();
    await audit(trx, subject, 'account.deleted', request.id, {});
  });
}

/**
 * The deletion worker (§16.6 step 3). Each pending request is either completed or
 * marked with what it is waiting for, which the person sees if they sign in again.
 */
export async function processDeletionRequests(p: {
  db: Kysely<Database>;
  storage: MediaStorage;
  clock: Clock;
  logger?: Pick<Logger, 'info' | 'error'>;
}): Promise<{ completed: number; waiting: number }> {
  const pending = await p.db
    .selectFrom('haven.deletion_requests')
    .select(['id', 'principal_type', 'principal_id'])
    .where('status', '=', 'pending')
    .orderBy('requested_at')
    .limit(100)
    .execute();

  let completed = 0;
  let waiting = 0;
  for (const r of pending) {
    const subject: Subject = { type: r.principal_type, id: r.principal_id };
    try {
      const now = p.clock.now();
      const b = await blockersFor(p.db, subject, now);
      if (b.waitingFor) {
        await p.db
          .updateTable('haven.deletion_requests')
          .set({ waiting_for: b.waitingFor, checked_at: now.toISOString() })
          .where('id', '=', r.id)
          .execute();
        waiting += 1;
        continue;
      }
      await complete(p.db, p.clock, { id: r.id, subject });
      completed += 1;
    } catch (err) {
      p.logger?.error({ err, deletionRequestId: r.id }, 'account deletion failed');
    }
  }
  if (completed > 0) {
    await purgeDueMedia({ db: p.db, storage: p.storage, now: p.clock.now(), logger: p.logger });
    p.logger?.info({ completed }, 'account deletions completed');
  }
  return { completed, waiting };
}

/** The person's open request, for `GET /me` — so the app can show it after sign-in. */
export async function openDeletionRequest(
  db: Db,
  subject: Subject,
): Promise<{ status: 'pending'; waitingFor: WaitingFor | null } | null> {
  const row = await db
    .selectFrom('haven.deletion_requests')
    .select('waiting_for')
    .where('principal_type', '=', subject.type)
    .where('principal_id', '=', subject.id)
    .where('status', '=', 'pending')
    .executeTakeFirst();
  return row ? { status: 'pending', waitingFor: row.waiting_for } : null;
}

/** Recorded by the route; exported for the route and tests. */
export async function recordDeletionRequest(
  trx: Transaction<Database>,
  subject: Subject,
  p: { reason: string | null; now: Date; waitingFor: WaitingFor | null },
): Promise<{ id: string; created: boolean }> {
  const existing = await trx
    .selectFrom('haven.deletion_requests')
    .select('id')
    .where('principal_type', '=', subject.type)
    .where('principal_id', '=', subject.id)
    .where('status', '=', 'pending')
    .executeTakeFirst();
  if (existing) return { id: existing.id, created: false };
  const row = await trx
    .insertInto('haven.deletion_requests')
    .values({
      principal_type: subject.type,
      principal_id: subject.id,
      reason: p.reason,
      waiting_for: p.waitingFor,
      requested_at: p.now.toISOString(),
      checked_at: p.now.toISOString(),
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  await audit(trx, subject, 'account.deletion_requested', row.id, { waitingFor: p.waitingFor });
  return { id: row.id, created: true };
}
