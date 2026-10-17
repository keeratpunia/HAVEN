import type { Transaction } from 'kysely';
import { defaultScreenForKind } from '@haven/shared';
import type { Database } from '../db/index.js';
import type { PushText, SmsText } from './templates.js';

/**
 * The single producer API for the notification outbox (SDD §9.7: "Producers ... only
 * INSERT into notifications. Nothing calls Expo or SMS inside a request"). Runs inside
 * the caller's transaction so a rolled-back change never notifies anyone (CLAUDE.md
 * §4). The worker (`worker.ts`) is the only thing that delivers.
 *
 * SMS fallback (SDD §9.7): "the producer inserts the push row and a linked SMS row
 * with next_attempt_at = now + fallback delay and cancel_if_opened = <push id>".
 */

export type Recipient = { type: 'user'; userId: string } | { type: 'visitor'; visitorId: string };

export interface EnqueueParams {
  now: Date;
  hostelId: string | null;
  recipient: Recipient;
  kind: string;
  channel: 'push' | 'in_app';
  text: PushText;
  visitId?: string | null;
  /** Route a tap opens (SDD §15.1). Defaults from the kind when omitted. */
  screen?: string;
  data?: Record<string, unknown>;
  dedupeKey?: string;
  /** `delayMs > 0` = fallback cancelled if the push is opened first; 0 = sent alongside. */
  sms?: { text: SmsText; delayMs: number };
}

export interface EnqueueResult {
  id: string | null;
  smsId: string | null;
}

export async function enqueueNotification(
  trx: Transaction<Database>,
  p: EnqueueParams,
): Promise<EnqueueResult> {
  const recipientId = p.recipient.type === 'user' ? p.recipient.userId : p.recipient.visitorId;
  const screen = p.screen ?? defaultScreenForKind(p.kind, p.visitId ?? null);

  const inserted = await trx
    .insertInto('haven.notifications')
    .values({
      hostel_id: p.hostelId,
      recipient_type: p.recipient.type,
      recipient_id: recipientId,
      kind: p.kind,
      channel: p.channel,
      visit_id: p.visitId ?? null,
      title: p.text.title,
      body: p.text.body,
      data: { screen, ...(p.data ?? {}) },
      dedupe_key: p.dedupeKey ?? null,
      next_attempt_at: p.now,
    })
    .onConflict((oc) => oc.column('dedupe_key').doNothing())
    .returning('id')
    .executeTakeFirst();

  // A dedupe hit means this exact notification was already produced — so was its SMS.
  if (!inserted) return { id: null, smsId: null };

  let smsId: string | null = null;
  if (p.sms) {
    const sms = await trx
      .insertInto('haven.notifications')
      .values({
        hostel_id: p.hostelId,
        recipient_type: p.recipient.type,
        recipient_id: recipientId,
        kind: p.kind,
        channel: 'sms',
        visit_id: p.visitId ?? null,
        title: null,
        body: p.sms.text.body,
        sms_template_id: p.sms.text.templateId,
        data: { screen },
        cancel_if_opened: p.sms.delayMs > 0 ? inserted.id : null,
        dedupe_key: p.dedupeKey ? `${p.dedupeKey}:sms` : null,
        next_attempt_at: new Date(p.now.getTime() + p.sms.delayMs),
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    smsId = sms.id;
  }

  return { id: inserted.id, smsId };
}

/** Every active warden of a hostel — recipients for N-OVERNIGHT-REQ, N-DISPUTE, N-RES-SUBMITTED. */
export async function wardenIdsFor(
  trx: Transaction<Database>,
  hostelId: string,
): Promise<string[]> {
  const rows = await trx
    .selectFrom('haven.role_assignments')
    .select('user_id')
    .where('hostel_id', '=', hostelId)
    .where('role', '=', 'warden')
    .where('revoked_at', 'is', null)
    .execute();
  return rows.map((r) => r.user_id);
}
