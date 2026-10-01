import type { Transaction } from 'kysely';
import type { Database } from '../db/index.js';
import type { ActorType, ChargeKind, GateEventKind, NotifChannel } from '../db/types.js';
import type { Clock } from '../lib/clock.js';

/**
 * The three side-effect kinds SDD §7.1's table names per transition — gate events,
 * notifications (outbox rows, never sent directly — SDD §9.7/CLAUDE.md §3.5: "Only
 * ever INSERT into `notifications`; nothing calls Expo Push or an SMS provider inside
 * a request handler"), and charges. Each insert here runs inside the caller's
 * transaction (SDD §7: "inside one database transaction that also writes the gate
 * event and audit row") — these are never called outside a `withTx` block.
 */

export interface GateEventParams {
  visitId: string;
  hostelId: string;
  gateId: string;
  scanSessionId?: string | null;
  kind: GateEventKind;
  actorType: ActorType;
  actorId: string | null;
  photoMediaId?: string | null;
  locationVerified: boolean;
  distanceM?: number | null;
  accuracyM?: number | null;
  ruleCodes?: string[];
}

export async function insertGateEvent(
  trx: Transaction<Database>,
  params: GateEventParams,
): Promise<void> {
  await trx
    .insertInto('haven.gate_events')
    .values({
      visit_id: params.visitId,
      hostel_id: params.hostelId,
      gate_id: params.gateId,
      scan_session_id: params.scanSessionId ?? null,
      kind: params.kind,
      actor_type: params.actorType,
      actor_id: params.actorId,
      photo_media_id: params.photoMediaId ?? null,
      location_verified: params.locationVerified,
      distance_m: params.distanceM ?? null,
      accuracy_m: params.accuracyM ?? null,
      rule_codes: params.ruleCodes ?? [],
    })
    .execute();
}

export interface NotificationParams {
  hostelId: string | null;
  recipientType: 'user' | 'visitor' | 'phone';
  recipientId?: string | null;
  recipientPhone?: string | null;
  kind: string;
  channel: NotifChannel;
  visitId?: string | null;
  title?: string | null;
  body: string;
  data?: Record<string, unknown>;
  dedupeKey?: string | null;
}

/** Only ever INSERTs — the notify worker (not built yet) is the only thing that sends. */
export async function insertNotification(
  trx: Transaction<Database>,
  params: NotificationParams,
): Promise<void> {
  await trx
    .insertInto('haven.notifications')
    .values({
      hostel_id: params.hostelId,
      recipient_type: params.recipientType,
      recipient_id: params.recipientId ?? null,
      recipient_phone: params.recipientPhone ?? null,
      kind: params.kind,
      channel: params.channel,
      visit_id: params.visitId ?? null,
      title: params.title ?? null,
      body: params.body,
      data: params.data ?? {},
      dedupe_key: params.dedupeKey ?? null,
    })
    .execute();
}

export interface CreatePendingChargeParams {
  hostelId: string;
  residentId: string;
  visitId: string;
  kind: ChargeKind;
  units: number;
  unitPriceInr: number;
  description: string;
  createdBy: string | null;
}

/** BR-08: a pending charge is created when the warden approves an overnight/guest-room request. */
export async function createPendingCharge(
  trx: Transaction<Database>,
  params: CreatePendingChargeParams,
): Promise<void> {
  await trx
    .insertInto('haven.charges')
    .values({
      hostel_id: params.hostelId,
      resident_id: params.residentId,
      visit_id: params.visitId,
      kind: params.kind,
      units: params.units,
      unit_price_inr: params.unitPriceInr,
      amount_inr: params.units * params.unitPriceInr,
      description: params.description,
      status: 'pending',
      created_by: params.createdBy,
    })
    .execute();
}

/** SDD §7.1: a visit's charge is waived automatically on cancel/expire-without-entry. */
export async function waiveChargeForVisit(
  trx: Transaction<Database>,
  visitId: string,
  clock: Clock,
  waivedBy: string | null,
): Promise<void> {
  await trx
    .updateTable('haven.charges')
    .set({
      status: 'waived',
      waived_by: waivedBy,
      waived_at: clock.now().toISOString(),
      waive_reason: 'Visit closed before the charge was confirmed.',
    })
    .where('visit_id', '=', visitId)
    .where('status', '=', 'pending')
    .execute();
}

/** SDD §7.1: a visit's charge is confirmed ("recalculated"/"finalised") when the stay actually ends. */
export async function confirmChargeForVisit(
  trx: Transaction<Database>,
  visitId: string,
  clock: Clock,
  confirmedBy: string | null,
): Promise<void> {
  await trx
    .updateTable('haven.charges')
    .set({
      status: 'confirmed',
      confirmed_by: confirmedBy,
      confirmed_at: clock.now().toISOString(),
    })
    .where('visit_id', '=', visitId)
    .where('status', '=', 'pending')
    .execute();
}
