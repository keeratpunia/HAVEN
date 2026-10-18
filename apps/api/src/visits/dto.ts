import type { Kysely } from 'kysely';
import {
  displayName,
  GH8_RULES_CONFIG_V1,
  maskPhone,
  type RulesConfig,
  type VisitAction,
  type VisitDTO,
  type VisitEventDTO,
} from '@haven/shared';
import type { Database } from '../db/index.js';
import type { Clock } from '../lib/clock.js';
import type { MediaUrlSigner } from '../media/signing.js';
import type { VisitRow } from './repository.js';
import { canShareInvite, hasArrivalCard, isEditable } from './host-actions.js';

/**
 * Host-view serializer for SDD §12.3's `VisitDTO`. Loads everything for a page of
 * visits in a fixed number of queries (not one per visit), signs photos per response
 * (120 s, SDD §9.10), and computes `allowedActions` for this caller — "The app MUST
 * use allowedActions to show or hide buttons instead of re-deriving permissions."
 * Only ever called for the visit's own host (callers check `visits.read` first).
 */

export interface DtoDeps {
  db: Kysely<Database>;
  clock: Clock;
  signer: MediaUrlSigner;
  /** The hostel's current rules (only the dispute window is needed here). */
  rulesFor: (hostelId: string) => Promise<RulesConfig>;
}

export async function buildHostVisitDtos(deps: DtoDeps, rows: VisitRow[]): Promise<VisitDTO[]> {
  if (rows.length === 0) return [];
  const { db } = deps;
  const visitIds = rows.map((r) => r.id);
  const hostelIds = [...new Set(rows.map((r) => r.hostel_id))];
  const hostIds = [...new Set(rows.map((r) => r.host_id))];
  const visitorIds = [...new Set(rows.flatMap((r) => (r.visitor_id ? [r.visitor_id] : [])))];

  const [hostels, hosts, visitors, photos, charges, pendingSessions] = await Promise.all([
    db
      .selectFrom('haven.hostels')
      .select(['id', 'code', 'name'])
      .where('id', 'in', hostelIds)
      .execute(),
    db
      .selectFrom('haven.users')
      .innerJoin('haven.residents', 'haven.residents.user_id', 'haven.users.id')
      .leftJoin('haven.rooms', 'haven.rooms.id', 'haven.residents.room_id')
      .select([
        'haven.users.id',
        'haven.users.full_name',
        'haven.rooms.number',
        'haven.residents.claimed_room',
      ])
      .where('haven.users.id', 'in', hostIds)
      .execute(),
    visitorIds.length
      ? db
          .selectFrom('haven.visitors')
          .select(['id', 'full_name', 'gender', 'phone', 'profile_media_id'])
          .where('id', 'in', visitorIds)
          .execute()
      : Promise.resolve([]),
    db
      .selectFrom('haven.gate_events')
      .select(['visit_id', 'photo_media_id', 'at'])
      .where('visit_id', 'in', visitIds)
      .where('photo_media_id', 'is not', null)
      .orderBy('at', 'desc')
      .execute(),
    db
      .selectFrom('haven.charges')
      .select(['visit_id', 'amount_inr', 'status'])
      .where('visit_id', 'in', visitIds)
      .execute(),
    // Sessions linked to these visits: a walk-in's (whose live photo R-08 shows before
    // any gate event exists) and a check-in awaiting the host's confirmation (F3).
    db
      .selectFrom('haven.scan_sessions')
      .select(['visit_id', 'photo_media_id', 'expires_at', 'consumed_at', 'gps_ok', 'created_at'])
      .where('visit_id', 'in', visitIds)
      .where('photo_media_id', 'is not', null)
      .orderBy('created_at', 'desc')
      .execute(),
  ]);

  const now = deps.clock.now();
  const rulesByHostel = new Map(
    await Promise.all(hostelIds.map(async (h) => [h, await deps.rulesFor(h)] as const)),
  );
  const hostelById = new Map(hostels.map((h) => [h.id, h]));
  const hostById = new Map(hosts.map((h) => [h.id, h]));
  const visitorById = new Map(visitors.map((v) => [v.id, v]));
  const latestPhotoByVisit = new Map<string, string>();
  for (const p of photos) {
    if (p.photo_media_id && !latestPhotoByVisit.has(p.visit_id)) {
      latestPhotoByVisit.set(p.visit_id, p.photo_media_id);
    }
  }
  const chargeByVisit = new Map(
    charges.flatMap((c) => (c.visit_id ? [[c.visit_id, c] as const] : [])),
  );
  const pendingByVisit = new Map<string, (typeof pendingSessions)[number]>();
  const sessionPhotoByVisit = new Map<string, string>();
  for (const s of pendingSessions) {
    if (!s.visit_id || !s.photo_media_id) continue;
    if (!sessionPhotoByVisit.has(s.visit_id)) sessionPhotoByVisit.set(s.visit_id, s.photo_media_id);
    const awaiting = s.consumed_at === null && !s.gps_ok && s.expires_at.getTime() > now.getTime();
    if (awaiting && !pendingByVisit.has(s.visit_id)) pendingByVisit.set(s.visit_id, s);
  }

  return rows.map((row) => {
    const hostel = hostelById.get(row.hostel_id);
    const host = hostById.get(row.host_id);
    const visitor = row.visitor_id ? visitorById.get(row.visitor_id) : undefined;
    const pending = pendingByVisit.get(row.id);
    const charge = chargeByVisit.get(row.id);
    const latestPhotoId =
      pending?.photo_media_id ??
      latestPhotoByVisit.get(row.id) ??
      sessionPhotoByVisit.get(row.id) ??
      null;
    const phone = visitor?.phone ?? row.invited_phone;
    const awaitingHostConfirmation = row.status === 'approved' && pending !== undefined;

    return {
      id: row.id,
      code: row.code,
      hostel: { id: row.hostel_id, code: hostel?.code ?? '', name: hostel?.name ?? '' },
      host: {
        id: row.host_id,
        displayName: displayName(host?.full_name ?? ''),
        room: host?.number ?? host?.claimed_room ?? '',
      },
      guest: {
        id: row.visitor_id,
        name: visitor?.full_name ?? row.invited_name ?? 'Guest',
        gender: visitor?.gender ?? row.invited_gender,
        phoneMasked: phone ? maskPhone(phone) : null,
        profilePhoto: deps.signer.signOrNull(visitor?.profile_media_id),
      },
      type: row.type,
      status: row.status,
      origin: row.origin,
      zone: row.zone,
      windowStart: row.window_start.toISOString(),
      windowEnd: row.window_end.toISOString(),
      nights: row.nights,
      flags: {
        overstay: row.overstay_since !== null,
        disputed: row.host_disputed_at !== null && row.dispute_resolved_at === null,
        locationUnverified: row.location_unverified,
        exitLocationUnverified: row.exit_location_unverified,
      },
      firstEntryAt: row.first_entry_at?.toISOString() ?? null,
      lastExitAt: row.last_exit_at?.toISOString() ?? null,
      latestPhoto: deps.signer.signOrNull(latestPhotoId),
      charge: charge ? { amountInr: charge.amount_inr, status: charge.status } : null,
      allowedActions: hostAllowedActions(
        row,
        awaitingHostConfirmation,
        now,
        rulesByHostel.get(row.hostel_id) ?? GH8_RULES_CONFIG_V1,
      ),
      hostConfirmedAt: row.host_confirmed_at?.toISOString() ?? null,
      awaitingHostConfirmation,
    };
  });
}

/** What the host may do right now — the server's answer, never re-derived in the app. */
export function hostAllowedActions(
  row: VisitRow,
  awaitingHostConfirmation: boolean,
  now: Date,
  cfg: RulesConfig,
): VisitAction[] {
  const actions: VisitAction[] = [];
  if (row.status === 'pending_host') actions.push('approve', 'reject');
  if (awaitingHostConfirmation) actions.push('confirm_arrival');

  const enteredAt = row.last_entry_at ?? row.first_entry_at;
  const inArrivalWindow =
    enteredAt !== null &&
    now.getTime() <= enteredAt.getTime() + cfg.dispute_window_minutes * 60_000;
  if (
    row.status === 'inside' &&
    hasArrivalCard(row) &&
    inArrivalWindow &&
    !row.host_confirmed_at &&
    !row.host_disputed_at
  ) {
    actions.push('confirm_arrival', 'dispute');
  }
  if (row.status === 'inside') actions.push('mark_left');
  if (
    (row.status === 'approved' && row.first_entry_at === null) ||
    row.status === 'pending_warden'
  ) {
    actions.push('cancel');
  }
  if (isEditable(row)) actions.push('edit');
  if (canShareInvite(row)) actions.push('share_invite');
  return actions;
}

/** R-10 timeline (SDD §14: "timeline (newest at bottom)"). */
export async function buildVisitEvents(deps: DtoDeps, row: VisitRow): Promise<VisitEventDTO[]> {
  const [approvals, gateEvents] = await Promise.all([
    deps.db
      .selectFrom('haven.approvals')
      .select(['decision', 'reason', 'decided_at'])
      .where('visit_id', '=', row.id)
      .execute(),
    deps.db
      .selectFrom('haven.gate_events')
      .select(['kind', 'at', 'location_verified', 'distance_m', 'photo_media_id'])
      .where('visit_id', '=', row.id)
      .execute(),
  ]);

  const events: VisitEventDTO[] = [{ kind: 'created', at: row.created_at.toISOString() }];
  for (const a of approvals) {
    events.push({
      kind: a.decision === 'approved' ? 'approved' : 'rejected',
      at: a.decided_at.toISOString(),
      reason: a.reason,
    });
  }
  for (const g of gateEvents) {
    events.push({
      kind: g.kind,
      at: g.at.toISOString(),
      locationVerified: g.location_verified,
      distanceM: g.distance_m,
      photo: deps.signer.signOrNull(g.photo_media_id),
    });
  }
  if (row.host_confirmed_at)
    events.push({ kind: 'host_confirmed', at: row.host_confirmed_at.toISOString() });
  if (row.host_disputed_at)
    events.push({ kind: 'disputed', at: row.host_disputed_at.toISOString() });
  if (row.dispute_resolved_at) {
    events.push({ kind: 'dispute_resolved', at: row.dispute_resolved_at.toISOString() });
  }
  if (row.overstay_since) events.push({ kind: 'overstay', at: row.overstay_since.toISOString() });
  if (row.closed_at) {
    events.push({
      kind: 'closed',
      at: row.closed_at.toISOString(),
      reason: row.close_reason ?? row.cancel_reason,
    });
  }
  return events.sort((a, b) => a.at.localeCompare(b.at));
}
