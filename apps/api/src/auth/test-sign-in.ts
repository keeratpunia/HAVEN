import type { Transaction } from 'kysely';
import type { Database } from '../db/index.js';
import type { Clock } from '../lib/clock.js';
import { AppError } from '../lib/errors.js';
import type { RoleGrant } from './jwt.js';
import { loadUserRoles } from './principal-loader.js';

/**
 * Resident and staff sign-in by test phone number (DEC-028), for the Phase 1 test version
 * (DEC-026), which has no Google sign-in. The route is registered only when APP_ENV is
 * not 'production', accepts only the SDD §9.5 test numbers with their fixed code, and is
 * the users' counterpart of the guests' test OTP:
 *
 * - a number that belongs to a seeded user signs in as that user (resident, warden,
 *   office, super admin);
 * - any other test number becomes a new applicant, phone already verified, who goes on
 *   to onboarding (F7) so the warden-verifies-a-resident flow can be shown.
 */

export interface TestSignInResult {
  userId: string;
  roles: RoleGrant[];
  created: boolean;
}

export async function testSignIn(
  trx: Transaction<Database>,
  clock: Clock,
  phone: string,
): Promise<TestSignInResult> {
  const now = clock.now().toISOString();
  const existing = await trx
    .selectFrom('haven.users')
    .select(['id', 'is_active'])
    .where('phone', '=', phone)
    .executeTakeFirst();
  if (existing) {
    if (!existing.is_active) {
      throw new AppError('FORBIDDEN', 403, 'This account has been deactivated.');
    }
    await trx
      .updateTable('haven.users')
      .set({ last_login_at: now })
      .where('id', '=', existing.id)
      .execute();
    return { userId: existing.id, roles: await loadUserRoles(trx, existing.id), created: false };
  }

  const digits = phone.slice(-10);
  const created = await trx
    .insertInto('haven.users')
    .values({
      google_sub: `test-phone:${phone}`,
      email: `test-${digits}@haven.test`,
      full_name: `Test resident ${digits.slice(-2)}`,
      phone,
      phone_verified_at: now,
      is_active: true,
      last_login_at: now,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return { userId: created.id, roles: [], created: true };
}
