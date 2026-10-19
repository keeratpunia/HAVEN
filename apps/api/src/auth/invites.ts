import type { Transaction } from 'kysely';
import type { Database } from '../db/index.js';
import { AppError } from '../lib/errors.js';
import { sha256 } from '../lib/crypto.js';
import type { Clock } from '../lib/clock.js';

/**
 * Guest invite claiming (SDD §9.6): `POST /v1/invites/{token}/claim`, guest-authed.
 * Succeeds only if the signed-in phone equals the visit's `invited_phone`
 * (`INVITE_PHONE_MISMATCH`, 403); already claimed by someone else is `CONFLICT` (409,
 * per SDD §12.2 `INVITE_ALREADY_CLAIMED`); an unknown/expired token is `INVITE_EXPIRED`
 * (410). This is scoped to claiming only — invite *creation* belongs to the visits
 * module (a host creating a visit), out of scope for the authentication milestone.
 */
export async function claimInvite(
  trx: Transaction<Database>,
  params: {
    token: string;
    visitorId: string;
    visitorPhone: string;
    /** Runs after the token and phone checks, before the visit is bound (F1 step 5:
     * PROFILE_INCOMPLETE comes after a phone mismatch, which G-02 shows first). */
    beforeBind?: () => Promise<void>;
  },
  clock: Clock,
): Promise<{ visitId: string }> {
  const tokenHash = sha256(params.token);
  const visit = await trx
    .selectFrom('haven.visits')
    .select(['id', 'visitor_id', 'invited_phone', 'window_end'])
    .where('invite_token_hash', '=', tokenHash)
    .executeTakeFirst();

  if (!visit || visit.window_end.getTime() <= clock.now().getTime()) {
    throw new AppError('INVITE_EXPIRED', 410, 'This invite link is no longer valid.');
  }

  if (visit.visitor_id) {
    if (visit.visitor_id === params.visitorId) {
      return { visitId: visit.id };
    }
    throw new AppError('INVITE_ALREADY_CLAIMED', 409, 'This invite has already been claimed.');
  }

  if (visit.invited_phone !== params.visitorPhone) {
    throw new AppError(
      'INVITE_PHONE_MISMATCH',
      403,
      'Sign in with the phone number this invite was sent to.',
    );
  }

  await params.beforeBind?.();
  await trx
    .updateTable('haven.visits')
    .set({ visitor_id: params.visitorId })
    .where('id', '=', visit.id)
    .execute();

  return { visitId: visit.id };
}
