import type { Transaction } from 'kysely';
import type { Database } from '../db/index.js';
import type { HostState } from '@haven/shared';

/** Loads the host's current status/suspension for the rules engine's `HostState` shape. */
export async function loadHostState(
  trx: Transaction<Database>,
  hostUserId: string,
): Promise<HostState> {
  const row = await trx
    .selectFrom('haven.residents')
    .select(['status', 'hosting_suspended_until'])
    .where('user_id', '=', hostUserId)
    .executeTakeFirst();
  if (!row) {
    // No resident row at all behaves like "not verified" — the rules engine denies
    // with HOST_NOT_VERIFIED either way, which is the correct outward behaviour.
    return { status: 'pending', suspendedUntil: null };
  }
  return { status: row.status, suspendedUntil: row.hosting_suspended_until };
}

/** BR: is this visitor currently banned, hostel-wide or at this specific hostel? */
export async function isVisitorBanned(
  trx: Transaction<Database>,
  visitorId: string | null,
  hostelId: string,
  now: Date,
): Promise<boolean> {
  if (!visitorId) return false;
  const row = await trx
    .selectFrom('haven.bans')
    .select('id')
    .where('visitor_id', '=', visitorId)
    .where('lifted_at', 'is', null)
    .where((eb) => eb.or([eb('ends_at', 'is', null), eb('ends_at', '>', now)]))
    .where((eb) => eb.or([eb('hostel_id', 'is', null), eb('hostel_id', '=', hostelId)]))
    .executeTakeFirst();
  return row !== undefined;
}
