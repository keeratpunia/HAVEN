import type { Transaction } from 'kysely';
import type { Database } from '../db/index.js';
import type { Clock } from '../lib/clock.js';
import { authorize } from '../auth/policy.js';
import { assertTransition } from '../visits/stateMachine.js';
import { updateVisitStatus } from '../visits/repository.js';
import { waiveChargeForVisit } from '../visits/sideEffects.js';
import type { RevocationCache } from '../auth/principal-loader.js';

/**
 * Side effects shared by several staff actions. Each runs inside the caller's
 * transaction, so the action and its consequences commit together (SDD §8.2).
 */

/**
 * FR-07: "all their sessions end immediately". Revokes every live session (refresh
 * tokens stop working) and drops the in-process session cache so the next request with
 * an existing access token gets SESSION_REVOKED (TC-SEC-05).
 */
export async function endAllSessions(
  trx: Transaction<Database>,
  p: { userId: string; reason: string; clock: Clock; cache: RevocationCache | null },
): Promise<number> {
  const rows = await trx
    .updateTable('haven.sessions')
    .set({ revoked_at: p.clock.now().toISOString(), revoke_reason: p.reason })
    .where('principal_type', '=', 'user')
    .where('principal_id', '=', p.userId)
    .where('revoked_at', 'is', null)
    .returning('id')
    .execute();
  // Also disable push tokens so a signed-out device stops getting staff alerts.
  await trx
    .updateTable('haven.push_tokens')
    .set({ disabled_at: p.clock.now() })
    .where('user_id', '=', p.userId)
    .where('disabled_at', 'is', null)
    .execute();
  p.cache?.forgetUser(p.userId);
  return rows.length;
}

/**
 * SDD §7.1 "approved → cancelled: Host cancels, or host suspended, or guest banned —
 * Host / system", BR-10 ("Existing future visits are cancelled when a suspension
 * starts"), E-18 (resident marked left). Only `approved` visits never entered have a
 * cancel transition; a guest already inside stays inside (E-11/E-12 — the warden
 * decides on force check-out). The transition is the system's, triggered by the
 * warden's own authorized action; the audit trigger records the warden as actor.
 */
export async function cancelFutureVisits(
  trx: Transaction<Database>,
  p: {
    where: { hostId: string } | { visitorId: string; hostelId: string | null };
    reason: string;
    clock: Clock;
    actorUserId: string;
  },
): Promise<string[]> {
  let q = trx
    .selectFrom('haven.visits')
    .select(['id', 'hostel_id', 'host_id', 'visitor_id', 'status'])
    .where('status', '=', 'approved')
    .where('first_entry_at', 'is', null);
  if ('hostId' in p.where) {
    q = q.where('host_id', '=', p.where.hostId);
  } else {
    q = q.where('visitor_id', '=', p.where.visitorId);
    if (p.where.hostelId) q = q.where('hostel_id', '=', p.where.hostelId);
  }
  const visits = await q.execute();
  for (const v of visits) {
    const transition = assertTransition(v.status, 'cancel_approved');
    authorize(null, 'visits.cancel_approved', {
      hostelId: v.hostel_id,
      hostUserId: v.host_id,
      visitorId: v.visitor_id,
      systemTriggered: true,
    });
    await updateVisitStatus(trx, {
      id: v.id,
      expectedStatus: transition.from as 'approved',
      newStatus: transition.to,
      patch: { cancelReason: p.reason, closedAt: p.clock.now() },
    });
    await waiveChargeForVisit(trx, v.id, p.clock, p.actorUserId);
  }
  return visits.map((v) => v.id);
}
