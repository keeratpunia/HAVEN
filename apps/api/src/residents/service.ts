import type { Kysely, Transaction } from 'kysely';
import type { ResidentProfileDTO } from '@haven/shared';
import type { Database } from '../db/index.js';
import type { Clock } from '../lib/clock.js';
import { AppError } from '../lib/errors.js';
import { withTx } from '../lib/tx.js';
import type { UserPrincipal } from '../auth/principal.js';
import { authorize } from '../auth/policy.js';
import { enqueueNotification, wardenIdsFor } from '../notify/outbox.js';
import { residentSubmittedText } from '../notify/templates.js';

/**
 * Resident onboarding (SDD F7, FR-04): R-02 phone OTP (`POST /auth/otp/verify`,
 * purpose `phone_verify`), R-03 hostel + room + ID card + selfie, then submit, then
 * R-04 waits for the warden. `residents.resubmissions <= 1` (SDD §11.2) caps a
 * rejected resident at one resubmission ("rejected — can resubmit once", §3.2).
 */

type Row = {
  hostel_id: string;
  claimed_room: string;
  room_id: string | null;
  status: 'pending' | 'verified' | 'rejected' | 'suspended' | 'left';
  id_card_media_id: string | null;
  selfie_media_id: string | null;
  submitted_at: Date | null;
  rejection_reason: string | null;
  resubmissions: number;
  hosting_suspended_until: Date | null;
};

async function residentRow(db: Kysely<Database> | Transaction<Database>, userId: string) {
  return (await db
    .selectFrom('haven.residents')
    .select([
      'hostel_id',
      'claimed_room',
      'room_id',
      'status',
      'id_card_media_id',
      'selfie_media_id',
      'submitted_at',
      'rejection_reason',
      'resubmissions',
      'hosting_suspended_until',
    ])
    .where('user_id', '=', userId)
    .executeTakeFirst()) as Row | undefined;
}

/** True while the resident may still change their details: never submitted, or
 * rejected with their one resubmission unused. */
function isEditableDraft(row: Row): boolean {
  return (row.status === 'pending' && row.submitted_at === null) || canResubmit(row);
}

function canResubmit(row: Row): boolean {
  return row.status === 'rejected' && row.resubmissions < 1;
}

export async function loadResidentProfile(
  db: Kysely<Database>,
  userId: string,
): Promise<ResidentProfileDTO | null> {
  const row = await residentRow(db, userId);
  if (!row) return null;
  const hostel = await db
    .selectFrom('haven.hostels')
    .select('name')
    .where('id', '=', row.hostel_id)
    .executeTakeFirstOrThrow();
  const room = row.room_id
    ? await db
        .selectFrom('haven.rooms')
        .select('number')
        .where('id', '=', row.room_id)
        .executeTakeFirst()
    : undefined;
  return {
    hostelId: row.hostel_id,
    hostelName: hostel.name,
    room: room?.number ?? row.claimed_room,
    status: row.status,
    submittedAt: row.submitted_at?.toISOString() ?? null,
    hasIdCard: row.id_card_media_id !== null,
    hasSelfie: row.selfie_media_id !== null,
    rejectionReason: row.rejection_reason,
    canResubmit: canResubmit(row),
    hostingSuspendedUntil: row.hosting_suspended_until?.toISOString() ?? null,
  };
}

/** `POST /residents/me { hostelId, room }` → Resident (status pending). */
export async function upsertResidentDraft(
  deps: { db: Kysely<Database> },
  p: { principal: UserPrincipal; requestId: string; hostelId: string; room: string },
): Promise<void> {
  authorize(p.principal, 'residents.update_self', { userId: p.principal.userId });
  await withTx(deps.db, { principal: p.principal, requestId: p.requestId }, async (trx) => {
    const hostel = await trx
      .selectFrom('haven.hostels')
      .select('id')
      .where('id', '=', p.hostelId)
      .executeTakeFirst();
    if (!hostel) throw new AppError('VALIDATION_FAILED', 400, 'Choose a hostel from the list.');

    const existing = await residentRow(trx, p.principal.userId);
    if (!existing) {
      await trx
        .insertInto('haven.residents')
        .values({ user_id: p.principal.userId, hostel_id: p.hostelId, claimed_room: p.room })
        .execute();
      return;
    }
    if (!isEditableDraft(existing)) {
      throw new AppError('CONFLICT', 409, 'Your details were already submitted.');
    }
    await trx
      .updateTable('haven.residents')
      .set({ hostel_id: p.hostelId, claimed_room: p.room, updated_at: new Date() })
      .where('user_id', '=', p.principal.userId)
      .execute();
  });
}

/** Records an uploaded ID card / selfie on the draft (`POST /residents/me/documents`). */
export async function attachResidentDocument(
  deps: { db: Kysely<Database> },
  p: { principal: UserPrincipal; requestId: string; kind: 'id_card' | 'selfie'; photoId: string },
): Promise<void> {
  authorize(p.principal, 'residents.update_self', { userId: p.principal.userId });
  await withTx(deps.db, { principal: p.principal, requestId: p.requestId }, async (trx) => {
    await trx
      .updateTable('haven.residents')
      .set(
        p.kind === 'id_card'
          ? { id_card_media_id: p.photoId, updated_at: new Date() }
          : { selfie_media_id: p.photoId, updated_at: new Date() },
      )
      .where('user_id', '=', p.principal.userId)
      .execute();
  });
}

/** Precondition shared by the documents upload: an editable draft must exist first. */
export async function assertEditableDraft(db: Kysely<Database>, userId: string): Promise<void> {
  const row = await residentRow(db, userId);
  if (!row) throw new AppError('VALIDATION_FAILED', 400, 'Enter your hostel and room first.');
  if (!isEditableDraft(row))
    throw new AppError('CONFLICT', 409, 'Your details were already submitted.');
}

/** `POST /residents/me/submit` — "needs phone verified + both documents; notifies wardens". */
export async function submitForVerification(
  deps: { db: Kysely<Database>; clock: Clock },
  p: { principal: UserPrincipal; requestId: string; consentVersion: string },
): Promise<void> {
  authorize(p.principal, 'residents.update_self', { userId: p.principal.userId });
  await withTx(deps.db, { principal: p.principal, requestId: p.requestId }, async (trx) => {
    const row = await residentRow(trx, p.principal.userId);
    if (!row) throw new AppError('VALIDATION_FAILED', 400, 'Enter your hostel and room first.');
    if (!isEditableDraft(row)) {
      throw new AppError('CONFLICT', 409, 'Your details were already submitted.');
    }
    const user = await trx
      .selectFrom('haven.users')
      .select(['full_name', 'phone_verified_at'])
      .where('id', '=', p.principal.userId)
      .executeTakeFirstOrThrow();
    const missing = [
      ...(user.phone_verified_at ? [] : ['phone']),
      ...(row.id_card_media_id ? [] : ['idCard']),
      ...(row.selfie_media_id ? [] : ['selfie']),
    ];
    if (missing.length > 0) {
      throw new AppError('VALIDATION_FAILED', 400, 'Finish every step before submitting.', {
        missing,
      });
    }

    const now = deps.clock.now();
    const resubmitting = row.status === 'rejected';
    await trx
      .updateTable('haven.residents')
      .set({
        status: 'pending',
        submitted_at: now.toISOString(),
        // §16.3: R-03's consent checkbox, recorded with the notice version it showed.
        consent_version: p.consentVersion,
        consent_at: now.toISOString(),
        rejection_reason: null,
        decided_at: null,
        decided_by: null,
        updated_at: now,
        ...(resubmitting ? { resubmissions: row.resubmissions + 1 } : {}),
      })
      .where('user_id', '=', p.principal.userId)
      .execute();

    for (const wardenId of await wardenIdsFor(trx, row.hostel_id)) {
      await enqueueNotification(trx, {
        now,
        hostelId: row.hostel_id,
        recipient: { type: 'user', userId: wardenId },
        kind: 'N-RES-SUBMITTED',
        channel: 'push',
        text: residentSubmittedText({ name: user.full_name, room: row.claimed_room }),
        dedupeKey: `res-submitted:${p.principal.userId}:${now.toISOString()}:${wardenId}`,
      });
    }
  });
}
