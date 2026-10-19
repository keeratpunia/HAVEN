import type { Kysely, Transaction } from 'kysely';
import { AppError } from '../lib/errors.js';
import type { Database } from '../db/index.js';
import type { Clock } from '../lib/clock.js';

/**
 * Guest ("visitor") identity for the OTP sign-in flow (SDD §9.5: "creates the visitor
 * if new ... response includes `profileComplete`").
 *
 * `haven.visitors.full_name`/`gender` are `NOT NULL` (SDD §11.2) but OTP verification
 * only proves a phone number, not a name — the SDD doesn't specify what a brand-new
 * visitor row should contain before the guest has filled in their profile. Resolved
 * (documented in docs/DECISIONS.md, DEC-007) as: a new visitor is created with the
 * placeholder name `DEFAULT_GUEST_NAME` and gender `'undisclosed'` (an existing,
 * valid `haven.gender` value — not a new one invented for this); `PATCH /me` (not
 * built in this milestone) is how a guest later sets their real name/gender.
 * `profileComplete` means every G-04/G-05 step is done (FR-02, §16.3): a real name,
 * 18+ confirmed, consent to the privacy notice recorded, and a live profile photo
 * (FINAL-QA-REPORT D-05).
 */
export const DEFAULT_GUEST_NAME = 'Guest';

export interface VisitorIdentity {
  visitorId: string;
  profileComplete: boolean;
}

export async function findOrCreateVisitorByPhone(
  trx: Transaction<Database>,
  phone: string,
  clock: Clock,
): Promise<VisitorIdentity> {
  const existing = await trx
    .selectFrom('haven.visitors')
    .select([
      'id',
      'full_name',
      'last_visit_at',
      'is_adult_confirmed',
      'consent_at',
      'profile_media_id',
    ])
    .where('phone', '=', phone)
    .executeTakeFirst();

  if (existing) {
    await trx
      .updateTable('haven.visitors')
      .set({ last_visit_at: clock.now().toISOString() })
      .where('id', '=', existing.id)
      .execute();
    return { visitorId: existing.id, profileComplete: isProfileComplete(existing) };
  }

  const inserted = await trx
    .insertInto('haven.visitors')
    .values({
      phone,
      full_name: DEFAULT_GUEST_NAME,
      gender: 'undisclosed',
      last_visit_at: clock.now().toISOString(),
    })
    .returning('id')
    .executeTakeFirstOrThrow();

  return { visitorId: inserted.id, profileComplete: false };
}

export interface VisitorProfileFacts {
  full_name: string;
  is_adult_confirmed: boolean;
  consent_at: Date | string | null;
  profile_media_id: string | null;
}

/** FR-02: name, gender (set with the name on G-04), 18+, consent, live profile photo. */
export function isProfileComplete(v: VisitorProfileFacts): boolean {
  return (
    v.full_name !== DEFAULT_GUEST_NAME &&
    v.is_adult_confirmed &&
    v.consent_at !== null &&
    v.profile_media_id !== null
  );
}

/**
 * SDD §12.2 `PROFILE_INCOMPLETE` (403, "Guest must finish profile first"): a guest
 * can't claim an invite, request entry or check in before G-04/G-05 are done. Checking
 * out is never refused (BR-17), and host-assisted guests (F4) are the host's record, so
 * neither goes through this.
 */
export async function assertVisitorProfileComplete(
  db: Kysely<Database> | Transaction<Database>,
  visitorId: string,
): Promise<void> {
  const row = await db
    .selectFrom('haven.visitors')
    .select(['full_name', 'is_adult_confirmed', 'consent_at', 'profile_media_id'])
    .where('id', '=', visitorId)
    .executeTakeFirst();
  if (!row || !isProfileComplete(row)) {
    throw new AppError('PROFILE_INCOMPLETE', 403, 'Finish your profile first.');
  }
}
