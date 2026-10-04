import type { Transaction } from 'kysely';
import type { Database } from '../db/index.js';
import { AppError } from '../lib/errors.js';
import type { Clock } from '../lib/clock.js';
import type { RoleGrant } from './jwt.js';

/**
 * Dev-only resident/staff sign-in bypass (demo milestone, docs/DECISIONS.md DEC-011).
 * Issues real tokens for an *existing* `haven.users` row found by email — it never
 * creates a user (unlike the real Google flow), so it can only ever sign in as
 * someone a seed script or the real Google flow already created. Gated twice: the
 * route this calls is only registered when `env.DEV_LOGIN_ENABLED` is true, and
 * `buildApp` refuses to boot with that flag on unless `process.env.NODE_ENV ===
 * 'development'` — this module has no gate of its own, by design, so there is only
 * one place to audit for "is the bypass actually reachable."
 */

export interface DevLoginResult {
  userId: string;
  roles: RoleGrant[];
}

export async function devLogin(
  trx: Transaction<Database>,
  clock: Clock,
  email: string,
): Promise<DevLoginResult> {
  const user = await trx
    .selectFrom('haven.users')
    .select(['id', 'is_active'])
    .where('email', '=', email.toLowerCase())
    .executeTakeFirst();
  if (!user) {
    throw new AppError('NOT_FOUND', 404, 'No account with that email. Seed it first.');
  }
  if (!user.is_active) {
    throw new AppError('FORBIDDEN', 403, 'This account has been deactivated.');
  }

  await trx
    .updateTable('haven.users')
    .set({ last_login_at: clock.now().toISOString() })
    .where('id', '=', user.id)
    .execute();

  const roleRows = await trx
    .selectFrom('haven.role_assignments')
    .select(['hostel_id', 'role'])
    .where('user_id', '=', user.id)
    .where('revoked_at', 'is', null)
    .execute();
  const roles: RoleGrant[] = roleRows
    .filter((row): row is { hostel_id: string; role: RoleGrant['r'] } => row.hostel_id !== null)
    .map((row) => ({ h: row.hostel_id, r: row.role }));

  return { userId: user.id, roles };
}
