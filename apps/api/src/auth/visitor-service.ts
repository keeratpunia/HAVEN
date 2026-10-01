import type { Transaction } from 'kysely';
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
 * `profileComplete` is exactly "the placeholder name has been replaced."
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
    .select(['id', 'full_name', 'last_visit_at'])
    .where('phone', '=', phone)
    .executeTakeFirst();

  if (existing) {
    await trx
      .updateTable('haven.visitors')
      .set({ last_visit_at: clock.now().toISOString() })
      .where('id', '=', existing.id)
      .execute();
    return { visitorId: existing.id, profileComplete: existing.full_name !== DEFAULT_GUEST_NAME };
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
