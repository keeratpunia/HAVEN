import type { Kysely, Transaction } from 'kysely';
import type { Database } from '../db/index.js';
import { AppError } from '../lib/errors.js';
import { sha256 } from '../lib/crypto.js';
import type { Clock } from '../lib/clock.js';
import type { GoogleIdTokenVerifier } from './google.js';
import type { RoleGrant } from './jwt.js';

/**
 * Resident/staff Google sign-in (SDD §9.5, §9.6, F11): verify the ID token, require
 * `email_verified`, upsert `haven.users` by `google_sub`, auto-accept any pending
 * staff invite addressed to that email — explicitly (if `staffInviteToken` names one,
 * enforcing `INVITE_EMAIL_MISMATCH` when it doesn't belong to this account) and
 * implicitly (any other still-pending invite for the same email, so a staff member
 * invited before their first sign-in gets their role without needing the token link at
 * all — "accepts any pending staff invite for that email").
 */

export interface GoogleSignInResult {
  userId: string;
  isNewUser: boolean;
  roles: RoleGrant[];
}

export async function signInWithGoogle(
  trx: Transaction<Database>,
  verifier: GoogleIdTokenVerifier,
  clock: Clock,
  params: { idToken: string; staffInviteToken?: string },
): Promise<GoogleSignInResult> {
  const verified = await verifier.verify(params.idToken);
  if (!verified.emailVerified) {
    throw new AppError('AUTH_REQUIRED', 401, 'Your Google account email is not verified.');
  }

  const now = clock.now();
  const existing = await trx
    .selectFrom('haven.users')
    .select(['id', 'is_active'])
    .where('google_sub', '=', verified.sub)
    .executeTakeFirst();

  let userId: string;
  let isNewUser: boolean;

  if (existing) {
    if (!existing.is_active) {
      throw new AppError('FORBIDDEN', 403, 'This account has been deactivated.');
    }
    userId = existing.id;
    isNewUser = false;
    await trx
      .updateTable('haven.users')
      .set({ last_login_at: now.toISOString() })
      .where('id', '=', userId)
      .execute();
  } else {
    const fullName = verified.name.length >= 2 ? verified.name.slice(0, 80) : 'Google User';
    const inserted = await trx
      .insertInto('haven.users')
      .values({
        google_sub: verified.sub,
        email: verified.email,
        full_name: fullName,
        is_active: true,
        last_login_at: now.toISOString(),
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    userId = inserted.id;
    isNewUser = true;
  }

  if (params.staffInviteToken) {
    const tokenHash = sha256(params.staffInviteToken);
    const invite = await trx
      .selectFrom('haven.staff_invites')
      .select(['id', 'email'])
      .where('token_hash', '=', tokenHash)
      .where('accepted_at', 'is', null)
      .where('revoked_at', 'is', null)
      .where('expires_at', '>', now)
      .executeTakeFirst();

    if (!invite) {
      throw new AppError('INVITE_EXPIRED', 410, 'This invite link is no longer valid.');
    }
    if (invite.email.toLowerCase() !== verified.email.toLowerCase()) {
      throw new AppError(
        'INVITE_EMAIL_MISMATCH',
        403,
        'Sign in with the email address this invite was sent to.',
      );
    }
  }

  const pendingInvites = await trx
    .selectFrom('haven.staff_invites')
    .select(['id', 'hostel_id', 'role'])
    .where('email', '=', verified.email)
    .where('accepted_at', 'is', null)
    .where('revoked_at', 'is', null)
    .where('expires_at', '>', now)
    .execute();

  for (const invite of pendingInvites) {
    await trx
      .insertInto('haven.role_assignments')
      .values({ user_id: userId, hostel_id: invite.hostel_id, role: invite.role })
      .execute();
    await trx
      .updateTable('haven.staff_invites')
      .set({ accepted_by: userId, accepted_at: now.toISOString() })
      .where('id', '=', invite.id)
      .execute();
  }

  const roleRows = await trx
    .selectFrom('haven.role_assignments')
    .select(['hostel_id', 'role'])
    .where('user_id', '=', userId)
    .where('revoked_at', 'is', null)
    .execute();
  const roles: RoleGrant[] = roleRows
    .filter((row): row is { hostel_id: string; role: RoleGrant['r'] } => row.hostel_id !== null)
    .map((row) => ({ h: row.hostel_id, r: row.role }));

  return { userId, isNewUser, roles };
}

export async function getResidentStatus(
  db: Kysely<Database> | Transaction<Database>,
  userId: string,
): Promise<string | null> {
  const row = await db
    .selectFrom('haven.residents')
    .select('status')
    .where('user_id', '=', userId)
    .executeTakeFirst();
  return row?.status ?? null;
}
