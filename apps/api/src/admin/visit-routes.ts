import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Kysely } from 'kysely';
import { z } from 'zod';
import {
  AdminVisitsQuerySchema,
  ForceCheckoutBodySchema,
  nightsBetween,
  quotaUsed,
  ReportQuerySchema,
  ResolveDisputeBodySchema,
  toLocalDateString,
  localDateTimeToUtc,
  type AdminVisitDetailDTO,
  type AdminVisitDTO,
  type ApprovalDTO,
  type DashboardDTO,
  type EmergencyRowDTO,
  type ReportDTO,
  type VisitAction,
} from '@haven/shared';
import type { ZodTypeProvider } from '../lib/validation.js';
import type { Database } from '../db/index.js';
import type { Clock } from '../lib/clock.js';
import { AppError } from '../lib/errors.js';
import { decodeCursor, pageOf } from '../lib/paging.js';
import { runIdempotent } from '../lib/idempotency.js';
import { withTx } from '../lib/tx.js';
import { authorize } from '../auth/policy.js';
import type { MediaUrlSigner } from '../media/signing.js';
import type { RulesProvider } from '../rules/provider.js';
import { buildHostVisitDtos, buildVisitEvents, type DtoDeps } from '../visits/dto.js';
import { findActiveOvernightBookings, findVisitById, type VisitRow } from '../visits/repository.js';
import { bookingDates, wardenForcesCheckout } from '../visits/service.js';
import { assertInHostel, staffScope, staffUser } from './scope.js';
import { writeAudit } from './audit.js';

/**
 * W-01..W-05 and W-12 endpoints (SDD §12.9): dashboard, visit search and detail, force
 * check-out, resolve dispute, emergency roll call, overnight approvals queue, reports.
 */

const ID = z.object({ id: z.string().uuid() });
const EmergencyQuery = z.object({ format: z.enum(['json', 'csv']).default('json') });
const ONLINE_WINDOW_MS = 5 * 60_000; // FR-29 / job_gate_offline: offline after 5 min silent

export interface AdminVisitRoutesOptions {
  db: Kysely<Database>;
  clock: Clock;
  signer: MediaUrlSigner;
  rules: RulesProvider;
  webBaseUrl: string;
}

/** CSV with every field quoted; formula-leading characters neutralised (CSV injection). */
export function toCsv(header: string[], rows: (string | number | null)[][]): string {
  const cell = (v: string | number | null) => {
    let s = v === null ? '' : String(v);
    if (/^[=+\-@]/.test(s)) s = `'${s}`;
    return `"${s.replace(/"/g, '""')}"`;
  };
  return [header, ...rows].map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';
}

export function wardenAllowedActions(row: VisitRow): VisitAction[] {
  const actions: VisitAction[] = [];
  if (row.status === 'pending_warden') actions.push('approve', 'reject');
  if (row.status === 'inside') actions.push('force_checkout');
  if (row.host_disputed_at && !row.dispute_resolved_at) actions.push('resolve_dispute');
  if (row.visitor_id) actions.push('ban');
  return actions;
}

export async function registerAdminVisitRoutes(
  app: FastifyInstance,
  opts: AdminVisitRoutesOptions,
): Promise<void> {
  const { db, clock, signer, rules } = opts;
  const api = app.withTypeProvider<ZodTypeProvider>();
  const dtoDeps: DtoDeps = {
    db,
    clock,
    signer,
    rulesFor: async (h) => (await rules.forHostel(h)).config,
  };

  async function adminDtos(rows: VisitRow[]): Promise<AdminVisitDTO[]> {
    const base = await buildHostVisitDtos(dtoDeps, rows);
    const visitorIds = [...new Set(rows.flatMap((r) => (r.visitor_id ? [r.visitor_id] : [])))];
    const phones = visitorIds.length
      ? await db
          .selectFrom('haven.visitors')
          .select(['id', 'phone'])
          .where('id', 'in', visitorIds)
          .execute()
      : [];
    const phoneById = new Map(phones.map((p) => [p.id, p.phone]));
    return base.map((dto, i) => {
      const row = rows[i] as VisitRow;
      return {
        ...dto,
        allowedActions: wardenAllowedActions(row),
        guestPhone:
          (row.visitor_id ? phoneById.get(row.visitor_id) : null) ?? row.invited_phone ?? null,
        closeReason: row.close_reason ?? row.cancel_reason,
        disputeResolvedAt: row.dispute_resolved_at?.toISOString() ?? null,
      };
    });
  }

  async function scopedVisit(request: FastifyRequest, id: string): Promise<VisitRow> {
    const visit = await db.transaction().execute((trx) => findVisitById(trx, id));
    if (!visit) throw new AppError('NOT_FOUND', 404, 'Visit not found.');
    assertInHostel(visit.hostel_id, request.hostelId);
    return visit;
  }

  function audit(
    request: FastifyRequest,
    action: string,
    entity: string,
    entityId: string | null,
    detail?: Record<string, unknown>,
  ) {
    return writeAudit(db, {
      actorId: staffUser(request).userId,
      hostelId: request.hostelId,
      action,
      entity,
      entityId,
      detail,
      ip: request.ip,
      requestId: request.id,
    });
  }

  // GET /v1/admin/dashboard — W-01 (FR-50).
  api.get('/admin/dashboard', { preHandler: staffScope }, async (request, reply) => {
    authorize(request.principal, 'admin.dashboard.read', { hostelId: request.hostelId });
    const h = request.hostelId;
    const { config } = await rules.forHostel(h);
    const now = clock.now();
    const today = toLocalDateString(now, config.timezone);
    const dayStart = localDateTimeToUtc(today, '00:00', config.timezone);
    const dayEnd = new Date(dayStart.getTime() + 24 * 3_600_000);

    const count = async (build: (q: ReturnType<typeof base>) => ReturnType<typeof base>) => {
      const r = await build(base())
        .select((eb) => eb.fn.countAll<string>().as('n'))
        .executeTakeFirstOrThrow();
      return Number(r.n);
    };
    const base = () => db.selectFrom('haven.visits').where('hostel_id', '=', h);

    const [inside, expectedToday, overstaying, disputed, pendingApprovals] = await Promise.all([
      count((q) => q.where('status', '=', 'inside')),
      count((q) =>
        q
          .where('status', '=', 'approved')
          .where('first_entry_at', 'is', null)
          .where('window_start', '<', dayEnd)
          .where('window_end', '>', dayStart),
      ),
      count((q) => q.where('status', '=', 'inside').where('overstay_since', 'is not', null)),
      count((q) =>
        q.where('host_disputed_at', 'is not', null).where('dispute_resolved_at', 'is', null),
      ),
      count((q) => q.where('status', '=', 'pending_warden')),
    ]);
    const pendingResidents = Number(
      (
        await db
          .selectFrom('haven.residents')
          .select((eb) => eb.fn.countAll<string>().as('n'))
          .where('hostel_id', '=', h)
          .where('status', '=', 'pending')
          .where('submitted_at', 'is not', null)
          .executeTakeFirstOrThrow()
      ).n,
    );

    const gates = await db
      .selectFrom('haven.gates')
      .select(['id', 'name', 'lat', 'lng'])
      .where('hostel_id', '=', h)
      .where('is_active', '=', true)
      .execute();
    const devices = gates.length
      ? await db
          .selectFrom('haven.gate_devices')
          .select(['gate_id', 'last_seen_at'])
          .where(
            'gate_id',
            'in',
            gates.map((g) => g.id),
          )
          .where('revoked_at', 'is', null)
          .execute()
      : [];
    const events = await db
      .selectFrom('haven.gate_events')
      .innerJoin('haven.visits', 'haven.visits.id', 'haven.gate_events.visit_id')
      .leftJoin('haven.visitors', 'haven.visitors.id', 'haven.visits.visitor_id')
      .select([
        'haven.gate_events.visit_id',
        'haven.visits.code',
        'haven.visits.invited_name',
        'haven.visitors.full_name',
        'haven.gate_events.kind',
        'haven.gate_events.at',
        'haven.gate_events.location_verified',
      ])
      .where('haven.gate_events.hostel_id', '=', h)
      .orderBy('haven.gate_events.at', 'desc')
      .limit(10)
      .execute();

    const dto: DashboardDTO = {
      counts: { inside, expectedToday, overstaying, disputed, pendingApprovals, pendingResidents },
      gates: gates.map((g) => {
        const seen = devices
          .filter((d) => d.gate_id === g.id && d.last_seen_at)
          .map((d) => (d.last_seen_at as Date).getTime());
        const last = seen.length ? Math.max(...seen) : null;
        return {
          id: g.id,
          name: g.name,
          online: last !== null && now.getTime() - last <= ONLINE_WINDOW_MS,
          lastSeenAt: last !== null ? new Date(last).toISOString() : null,
          configured: g.lat !== null && g.lng !== null,
        };
      }),
      latestEvents: events.map((e) => ({
        visitId: e.visit_id,
        visitCode: e.code,
        guestName: e.full_name ?? e.invited_name ?? 'Guest',
        kind: e.kind,
        at: e.at.toISOString(),
        locationVerified: e.location_verified,
      })),
    };
    reply.send(dto);
  });

  // GET /v1/admin/visits — search (FR-57); also W-02 (status=inside) and the tiles.
  api.get(
    '/admin/visits',
    { schema: { querystring: AdminVisitsQuerySchema }, preHandler: staffScope },
    async (request, reply) => {
      authorize(request.principal, 'admin.visits.read', { hostelId: request.hostelId });
      const q = request.query;
      const { config } = await rules.forHostel(request.hostelId);
      const offset = decodeCursor(q.cursor);
      let query = db
        .selectFrom('haven.visits')
        .leftJoin('haven.visitors', 'haven.visitors.id', 'haven.visits.visitor_id')
        .innerJoin('haven.users as host', 'host.id', 'haven.visits.host_id')
        .innerJoin('haven.residents', 'haven.residents.user_id', 'haven.visits.host_id')
        .leftJoin('haven.rooms', 'haven.rooms.id', 'haven.residents.room_id')
        .selectAll('haven.visits')
        .where('haven.visits.hostel_id', '=', request.hostelId);
      if (q.status) query = query.where('haven.visits.status', '=', q.status);
      // W-08 resident detail: one host's visits (DEC-031).
      if (q.hostId) query = query.where('haven.visits.host_id', '=', q.hostId);
      if (q.type) query = query.where('haven.visits.type', '=', q.type);
      if (q.flag === 'overstay')
        query = query
          .where('haven.visits.overstay_since', 'is not', null)
          .where('haven.visits.status', '=', 'inside');
      if (q.flag === 'disputed') {
        query = query
          .where('haven.visits.host_disputed_at', 'is not', null)
          .where('haven.visits.dispute_resolved_at', 'is', null);
      }
      if (q.flag === 'location_unverified')
        query = query.where('haven.visits.location_unverified', '=', true);
      if (q.flag === 'exit_location_unverified')
        query = query.where('haven.visits.exit_location_unverified', '=', true);
      if (q.flag === 'host_marked_left')
        query = query.where('haven.visits.close_reason', '=', 'host_marked_left');
      if (q.expectedToday) {
        const today = toLocalDateString(clock.now(), config.timezone);
        const start = localDateTimeToUtc(today, '00:00', config.timezone);
        query = query
          .where('haven.visits.status', '=', 'approved')
          .where('haven.visits.first_entry_at', 'is', null)
          .where('haven.visits.window_start', '<', new Date(start.getTime() + 86_400_000))
          .where('haven.visits.window_end', '>', start);
      }
      if (q.from)
        query = query.where(
          'haven.visits.window_end',
          '>=',
          localDateTimeToUtc(q.from, '00:00', config.timezone),
        );
      if (q.to) {
        const end = new Date(
          localDateTimeToUtc(q.to, '00:00', config.timezone).getTime() + 86_400_000,
        );
        query = query.where('haven.visits.window_start', '<', end);
      }
      if (q.q) {
        const like = `%${q.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
        const digits = q.q.replace(/\D/g, '');
        query = query.where((eb) =>
          eb.or([
            eb('haven.visitors.full_name', 'ilike', like),
            eb('haven.visits.invited_name', 'ilike', like),
            eb('host.full_name', 'ilike', like),
            eb('haven.rooms.number', 'ilike', like),
            eb('haven.residents.claimed_room', 'ilike', like),
            eb('haven.visits.code', 'ilike', like),
            ...(digits.length >= 4
              ? [
                  eb('haven.visitors.phone', 'like', `%${digits}%`),
                  eb('haven.visits.invited_phone', 'like', `%${digits}%`),
                ]
              : []),
          ]),
        );
      }
      const order =
        q.status === 'inside' ? 'haven.visits.last_entry_at' : 'haven.visits.window_start';
      const rows = (await query
        .orderBy(order, 'desc')
        .orderBy('haven.visits.id')
        .offset(offset)
        .limit(q.limit + 1)
        .execute()) as VisitRow[];
      const page = pageOf(rows, offset, q.limit);
      reply.send({ items: await adminDtos(page.items), nextCursor: page.nextCursor });
    },
  );

  // GET /v1/admin/visits/:id — W-05 (FR-52). Audited read (SDD §16.4).
  api.get(
    '/admin/visits/:id',
    { schema: { params: ID }, preHandler: staffScope },
    async (request, reply) => {
      authorize(request.principal, 'admin.visits.read', { hostelId: request.hostelId });
      const visit = await scopedVisit(request, request.params.id);
      const [dto] = await adminDtos([visit]);
      if (!dto) throw new AppError('INTERNAL', 500, 'Could not serialize visit.');
      const notifications = await db
        .selectFrom('haven.notifications')
        .select([
          'kind',
          'channel',
          'status',
          'recipient_type',
          'created_at',
          'sent_at',
          'opened_at',
        ])
        .where('visit_id', '=', visit.id)
        .orderBy('created_at', 'asc')
        .execute();
      const detail: AdminVisitDetailDTO = {
        ...dto,
        events: await buildVisitEvents(dtoDeps, visit),
        notifications: notifications.map((n) => ({
          kind: n.kind,
          channel: n.channel,
          status: n.status,
          recipientType: n.recipient_type,
          createdAt: n.created_at.toISOString(),
          sentAt: n.sent_at?.toISOString() ?? null,
          openedAt: n.opened_at?.toISOString() ?? null,
        })),
      };
      await audit(request, 'read.visit', 'visits', visit.id);
      reply.send(detail);
    },
  );

  // POST /v1/admin/visits/:id/force-checkout ★ (FR-53, §7.1 last row).
  api.post(
    '/admin/visits/:id/force-checkout',
    { schema: { params: ID, body: ForceCheckoutBodySchema }, preHandler: staffScope },
    async (request, reply) => {
      authorize(request.principal, 'admin.visits.force_checkout', { hostelId: request.hostelId });
      await runIdempotent(db, request, reply, async () => {
        const visit = await scopedVisit(request, request.params.id);
        const { config, version } = await rules.forHostel(visit.hostel_id);
        await wardenForcesCheckout(
          { db, clock, rulesConfig: config, rulesVersion: version, webBaseUrl: opts.webBaseUrl },
          {
            principal: request.principal,
            requestId: request.id,
            visitId: visit.id,
            reason: request.body.reason,
          },
        );
        await audit(request, 'admin.visits.force_checkout', 'visits', visit.id, {
          reason: request.body.reason,
        });
        const [dto] = await adminDtos([await scopedVisit(request, visit.id)]);
        return { status: 200, body: dto };
      });
    },
  );

  // POST /v1/admin/visits/:id/resolve-dispute (F9 step 4; flag cleared, §7.2).
  api.post(
    '/admin/visits/:id/resolve-dispute',
    { schema: { params: ID, body: ResolveDisputeBodySchema }, preHandler: staffScope },
    async (request, reply) => {
      authorize(request.principal, 'admin.visits.resolve_dispute', { hostelId: request.hostelId });
      const visit = await scopedVisit(request, request.params.id);
      const user = staffUser(request);
      await withTx(db, { principal: request.principal, requestId: request.id }, async (trx) => {
        const row = await trx
          .updateTable('haven.visits')
          .set({ dispute_resolved_at: clock.now().toISOString(), dispute_resolved_by: user.userId })
          .where('id', '=', visit.id)
          .where('host_disputed_at', 'is not', null)
          .where('dispute_resolved_at', 'is', null)
          .returning('id')
          .executeTakeFirst();
        if (!row) throw new AppError('INVALID_TRANSITION', 409, 'This visit has no open dispute.');
        await writeAudit(trx, {
          actorId: user.userId,
          hostelId: request.hostelId,
          action: 'admin.visits.resolve_dispute',
          entity: 'visits',
          entityId: visit.id,
          detail: request.body.note ? { note: request.body.note } : null,
          ip: request.ip,
          requestId: request.id,
        });
      });
      const [dto] = await adminDtos([await scopedVisit(request, visit.id)]);
      reply.send(dto);
    },
  );

  // GET /v1/admin/emergency[?format=csv] — W-03 (FR-51). Audited read (SDD §16.4).
  api.get(
    '/admin/emergency',
    { schema: { querystring: EmergencyQuery }, preHandler: staffScope },
    async (request, reply) => {
      authorize(request.principal, 'admin.emergency.read', { hostelId: request.hostelId });
      const rows = await db
        .selectFrom('haven.visits')
        .leftJoin('haven.visitors', 'haven.visitors.id', 'haven.visits.visitor_id')
        .innerJoin('haven.users as host', 'host.id', 'haven.visits.host_id')
        .innerJoin('haven.residents', 'haven.residents.user_id', 'haven.visits.host_id')
        .leftJoin('haven.rooms', 'haven.rooms.id', 'haven.residents.room_id')
        .select([
          'haven.visits.id',
          'haven.visits.type',
          'haven.visits.zone',
          'haven.visits.last_entry_at',
          'haven.visits.first_entry_at',
          'haven.visits.invited_name',
          'haven.visitors.full_name as guest_name',
          'host.full_name as host_name',
          'haven.rooms.number as room_number',
          'haven.residents.claimed_room',
        ])
        .where('haven.visits.hostel_id', '=', request.hostelId)
        .where('haven.visits.status', '=', 'inside')
        .execute();
      const items: EmergencyRowDTO[] = rows
        .map((r) => ({
          visitId: r.id,
          guestName: r.guest_name ?? r.invited_name ?? 'Guest',
          hostName: r.host_name,
          room: r.room_number ?? r.claimed_room,
          zone: r.zone,
          since: (r.last_entry_at ?? r.first_entry_at ?? new Date(0)).toISOString(),
          type: r.type,
        }))
        .sort((a, b) => a.room.localeCompare(b.room, 'en', { numeric: true }));
      await audit(request, 'read.emergency', 'visits', null, {
        count: items.length,
        format: request.query.format,
      });
      if (request.query.format === 'csv') {
        reply
          .header('Content-Type', 'text/csv; charset=utf-8')
          .header('Content-Disposition', 'attachment; filename="roll-call.csv"')
          .send(
            toCsv(
              ['Room', 'Guest', 'Host', 'Zone', 'Type', 'Inside since (UTC)'],
              items.map((i) => [i.room, i.guestName, i.hostName, i.zone, i.type, i.since]),
            ),
          );
        return;
      }
      reply.send({ count: items.length, items });
    },
  );

  // GET /v1/admin/approvals — W-04 overnight tab (F6 step 4).
  api.get('/admin/approvals', { preHandler: staffScope }, async (request, reply) => {
    authorize(request.principal, 'admin.approvals.read', { hostelId: request.hostelId });
    const { config } = await rules.forHostel(request.hostelId);
    const rows = (await db
      .selectFrom('haven.visits')
      .selectAll()
      .where('hostel_id', '=', request.hostelId)
      .where('status', '=', 'pending_warden')
      .orderBy('created_at', 'asc')
      .execute()) as VisitRow[];
    const dtos = await adminDtos(rows);
    const items: ApprovalDTO[] = [];
    for (const [i, row] of rows.entries()) {
      const dto = dtos[i] as AdminVisitDTO;
      const { arrivalDate, departureDate } = bookingDates(
        { windowStart: row.window_start, windowEnd: row.window_end },
        config.timezone,
      );
      const nights = nightsBetween(arrivalDate, departureDate);
      const perNight =
        row.type === 'overnight_room'
          ? config.overnight_room.charge_per_night_inr
          : config.guest_room.charge_per_night_inr;
      const booked = (
        await db.transaction().execute((trx) => findActiveOvernightBookings(trx, row.host_id))
      ).flatMap((b) => {
        const d = bookingDates(b, config.timezone);
        return nightsBetween(d.arrivalDate, d.departureDate);
      });
      const months = [...new Set(nights.map((n) => n.slice(0, 7)))];
      const history = await db
        .selectFrom('haven.visits')
        .select((eb) => [
          eb.fn.countAll<string>().as('visits'),
          eb.fn
            .count<string>(
              eb
                .case()
                .when(
                  eb.and([
                    eb('type', 'in', ['overnight_room', 'guest_room']),
                    eb('status', '=', 'completed'),
                  ]),
                )
                .then(1)
                .end(),
            )
            .as('overnight'),
          eb.fn.count<string>('host_disputed_at').as('disputes'),
        ])
        .where('host_id', '=', row.host_id)
        .where('id', '!=', row.id)
        .executeTakeFirstOrThrow();
      items.push({
        visit: dto,
        arrivalDate,
        departureDate,
        chargeInr: nights.length * perNight,
        quota:
          row.type === 'overnight_room'
            ? months.map((m) => ({
                month: m,
                used: quotaUsed(booked, m),
                limit: config.overnight_room.max_nights_per_month,
              }))
            : [],
        hostHistory: {
          visits: Number(history.visits),
          overnightStays: Number(history.overnight),
          disputes: Number(history.disputes),
        },
      });
    }
    reply.send({ items });
  });

  async function reportRows(request: FastifyRequest, from: string, to: string) {
    const { config } = await rules.forHostel(request.hostelId);
    const start = localDateTimeToUtc(from, '00:00', config.timezone);
    const end = new Date(localDateTimeToUtc(to, '00:00', config.timezone).getTime() + 86_400_000);
    if (end <= start)
      throw new AppError('VALIDATION_FAILED', 400, '"to" must not be before "from".');
    return db
      .selectFrom('haven.visits')
      .leftJoin('haven.visitors', 'haven.visitors.id', 'haven.visits.visitor_id')
      .innerJoin('haven.users as host', 'host.id', 'haven.visits.host_id')
      .innerJoin('haven.residents', 'haven.residents.user_id', 'haven.visits.host_id')
      .leftJoin('haven.rooms', 'haven.rooms.id', 'haven.residents.room_id')
      .select([
        'haven.visits.code',
        'haven.visits.type',
        'haven.visits.status',
        'haven.visits.window_start',
        'haven.visits.window_end',
        'haven.visits.first_entry_at',
        'haven.visits.last_exit_at',
        'haven.visits.overstay_since',
        'haven.visits.host_disputed_at',
        'haven.visits.location_unverified',
        'haven.visits.close_reason',
        'haven.visits.invited_name',
        'haven.visitors.full_name as guest_name',
        'host.full_name as host_name',
        'haven.rooms.number as room_number',
        'haven.residents.claimed_room',
      ])
      .where('haven.visits.hostel_id', '=', request.hostelId)
      .where('haven.visits.window_start', '>=', start)
      .where('haven.visits.window_start', '<', end)
      .orderBy('haven.visits.window_start', 'asc')
      .execute();
  }

  // GET /v1/admin/reports/visits — W-12 counts (DEC-014: JSON companion to the CSV).
  api.get(
    '/admin/reports/visits',
    { schema: { querystring: ReportQuerySchema }, preHandler: staffScope },
    async (request, reply) => {
      authorize(request.principal, 'admin.reports.read', { hostelId: request.hostelId });
      const rows = await reportRows(request, request.query.from, request.query.to);
      const tally = (key: 'type' | 'status') =>
        rows.reduce<Record<string, number>>(
          (acc, r) => ({ ...acc, [r[key]]: (acc[r[key]] ?? 0) + 1 }),
          {},
        );
      const dto: ReportDTO = {
        from: request.query.from,
        to: request.query.to,
        total: rows.length,
        byType: tally('type'),
        byStatus: tally('status'),
        flags: {
          overstay: rows.filter((r) => r.overstay_since).length,
          disputed: rows.filter((r) => r.host_disputed_at).length,
          locationUnverified: rows.filter((r) => r.location_unverified).length,
          forced: rows.filter((r) => r.close_reason === 'forced').length,
        },
      };
      reply.send(dto);
    },
  );

  // GET /v1/admin/reports/visits.csv — W-12 export (FR-57). Audited (SDD §16.4).
  api.get(
    '/admin/reports/visits.csv',
    { schema: { querystring: ReportQuerySchema }, preHandler: staffScope },
    async (request, reply) => {
      authorize(request.principal, 'admin.reports.read', { hostelId: request.hostelId });
      const rows = await reportRows(request, request.query.from, request.query.to);
      await audit(request, 'read.export', 'visits', null, {
        from: request.query.from,
        to: request.query.to,
        count: rows.length,
      });
      const iso = (d: Date | null) => (d ? d.toISOString() : null);
      reply
        .header('Content-Type', 'text/csv; charset=utf-8')
        .header(
          'Content-Disposition',
          `attachment; filename="visits-${request.query.from}-to-${request.query.to}.csv"`,
        )
        .send(
          toCsv(
            [
              'Code',
              'Type',
              'Status',
              'Guest',
              'Host',
              'Room',
              'Window start (UTC)',
              'Window end (UTC)',
              'First entry (UTC)',
              'Last exit (UTC)',
              'Overstay',
              'Disputed',
              'Location unverified',
              'Close reason',
            ],
            rows.map((r) => [
              r.code,
              r.type,
              r.status,
              r.guest_name ?? r.invited_name,
              r.host_name,
              r.room_number ?? r.claimed_room,
              iso(r.window_start),
              iso(r.window_end),
              iso(r.first_entry_at),
              iso(r.last_exit_at),
              r.overstay_since ? 'yes' : '',
              r.host_disputed_at ? 'yes' : '',
              r.location_unverified ? 'yes' : '',
              r.close_reason,
            ]),
          ),
        );
    },
  );
}
