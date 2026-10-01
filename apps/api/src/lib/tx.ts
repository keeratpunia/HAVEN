import { sql, type Kysely, type Transaction } from 'kysely';
import type { Database } from '../db/index.js';
import type { Principal } from '../auth/principal.js';

/**
 * Transaction wrapper every mutating service call uses (SDD §8.2: "Every mutating
 * service call runs in one transaction that writes the change, the audit_log row (via
 * trigger), any gate_events row and any notifications rows"; SDD §11.6: "The API sets
 * transaction-local settings at the start of every write transaction:
 * `set_config('haven.actor_type', $1, true), set_config('haven.actor_id', $2, true),
 * set_config('haven.request_id', $3, true)`"). The `audit_row()` trigger
 * (`supabase/migrations/20261001000001_init.sql`) reads those settings to attribute
 * every row change to an actor — without this wrapper, every future `audit_log` row
 * would attribute to `'system'` by the trigger's own fallback, which is wrong for
 * anything a real user or visitor did.
 *
 * This is infrastructure, not business logic: it has no opinion about *what* a
 * service does inside the transaction, only that the actor/request-id context is set
 * first. Feature services call it as `withTx(db, { principal, requestId }, async (trx) => { ... })`.
 */

export interface TxContext {
  principal: Principal | null;
  requestId: string;
}

export function actorTypeFor(
  principal: Principal | null,
): 'user' | 'visitor' | 'gate_device' | 'system' {
  if (principal === null) return 'system';
  if (principal.type === 'device') return 'gate_device';
  return principal.type;
}

export function actorIdFor(principal: Principal | null): string | null {
  if (principal === null) return null;
  if (principal.type === 'user') return principal.userId;
  if (principal.type === 'visitor') return principal.visitorId;
  return principal.deviceId;
}

async function setActorContext(trx: Transaction<Database>, ctx: TxContext): Promise<void> {
  const actorId = actorIdFor(ctx.principal);
  await sql`select set_config('haven.actor_type', ${actorTypeFor(ctx.principal)}, true),
                   set_config('haven.actor_id', ${actorId ?? ''}, true),
                   set_config('haven.request_id', ${ctx.requestId}, true)`.execute(trx);
}

export async function withTx<TResult>(
  db: Kysely<Database>,
  ctx: TxContext,
  fn: (trx: Transaction<Database>) => Promise<TResult>,
  /**
   * Overridable only for unit tests that can't drive a real Postgres connection
   * end to end (mirrors `BuildAppOptions.checkDb` in `app.ts`) — real callers never
   * pass this.
   */
  setActorContextImpl: typeof setActorContext = setActorContext,
): Promise<TResult> {
  return db.transaction().execute(async (trx) => {
    await setActorContextImpl(trx, ctx);
    return fn(trx);
  });
}
