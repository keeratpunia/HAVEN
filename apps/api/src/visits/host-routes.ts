import type { FastifyInstance } from 'fastify';
import type { Kysely } from 'kysely';
import { z } from 'zod';
import {
  ApproveBodySchema,
  CancelBodySchema,
  ChargesQuerySchema,
  CreateVisitBodySchema,
  DisputeBodySchema,
  HostedVisitsQuerySchema,
  nightsBetween,
  PatchVisitBodySchema,
  QuotaQuerySchema,
  RejectBodySchema,
  toLocalDateString,
  type ChargeDTO,
  type VisitDetailDTO,
} from '@haven/shared';
import type { ZodTypeProvider } from '../lib/validation.js';
import type { Database } from '../db/index.js';
import type { Clock } from '../lib/clock.js';
import { AppError } from '../lib/errors.js';
import { decodeCursor, pageOf } from '../lib/paging.js';
import { runIdempotent } from '../lib/idempotency.js';
import { requireAuth } from '../auth/authenticate.js';
import { authorize } from '../auth/policy.js';
import type { Principal, UserPrincipal } from '../auth/principal.js';
import type { MediaUrlSigner } from '../media/signing.js';
import {
  approveOvernight,
  approveWalkIn,
  cancelApprovedVisit,
  cancelOvernightRequest,
  cancelWalkIn,
  createOvernightRequest,
  createPreInvite,
  hostMarksGuestLeft,
  rejectOvernight,
  rejectWalkIn,
  type VisitServiceDeps,
  type WalkInGateContext,
} from './service.js';
import {
  confirmArrival,
  disputeArrival,
  editVisitWindow,
  overnightWindow,
  previewVisit,
  quotaFor,
  regenerateInviteLink,
} from './host-actions.js';
import { buildHostVisitDtos, buildVisitEvents, type DtoDeps } from './dto.js';
import { findVisitById, type VisitRow } from './repository.js';
import { visitDto } from './routes.js';
import type { RulesProvider } from '../rules/provider.js';
import { findWalkInSessionForVisit } from '../gate/scanSessions.js';

/**
 * Host-facing visits routes (SDD §12.6) plus the resident's quota and charges
 * (§12.5). Every ★ route requires `Idempotency-Key` (§9.12). A visit the caller may
 * not read is NOT_FOUND, never FORBIDDEN (SDD §12.2 "missing or not visible to
 * caller"; TC-SEC-01/02).
 */

const VISIT_ID_PARAMS = z.object({ id: z.string().uuid() });

export interface HostVisitRoutesOptions {
  db: Kysely<Database>;
  clock: Clock;
  signer: MediaUrlSigner;
  webBaseUrl: string;
  rules: RulesProvider;
}

function requireUser(principal: Principal | null | undefined): UserPrincipal {
  if (!principal || principal.type !== 'user') {
    throw new AppError('AUTH_REQUIRED', 401, 'Sign in as a resident to do this.');
  }
  return principal;
}

export async function registerHostVisitRoutes(
  app: FastifyInstance,
  opts: HostVisitRoutesOptions,
): Promise<void> {
  const { db, clock, signer } = opts;
  const dtoDeps: DtoDeps = {
    db,
    clock,
    signer,
    rulesFor: async (h) => (await opts.rules.forHostel(h)).config,
  };

  /** Service deps carrying the hostel's current rules version (SDD §4, E-13). */
  async function depsFor(hostelId: string): Promise<VisitServiceDeps> {
    const { config, version } = await opts.rules.forHostel(hostelId);
    return { db, clock, rulesConfig: config, rulesVersion: version, webBaseUrl: opts.webBaseUrl };
  }
  const api = app.withTypeProvider<ZodTypeProvider>();

  /** The caller's own resident row; 403 when the user isn't a resident at all. */
  async function residentOf(userId: string) {
    const resident = await db
      .selectFrom('haven.residents')
      .select(['hostel_id', 'status'])
      .where('user_id', '=', userId)
      .executeTakeFirst();
    if (!resident) throw new AppError('FORBIDDEN', 403, 'Only residents can host guests.');
    return resident;
  }

  /** Loads a visit only if the caller may read it — otherwise NOT_FOUND (SDD §12.2). */
  async function visibleVisit(principal: Principal | null, visitId: string): Promise<VisitRow> {
    const visit = await db.transaction().execute((trx) => findVisitById(trx, visitId));
    if (!visit) throw new AppError('NOT_FOUND', 404, 'Visit not found.');
    try {
      authorize(principal, 'visits.read', {
        hostelId: visit.hostel_id,
        hostUserId: visit.host_id,
        visitorId: visit.visitor_id,
      });
    } catch {
      throw new AppError('NOT_FOUND', 404, 'Visit not found.');
    }
    return visit;
  }

  async function dtoFor(visit: VisitRow) {
    const [dto] = await buildHostVisitDtos(dtoDeps, [visit]);
    // buildHostVisitDtos maps 1:1, so one row in is always one DTO out.
    if (!dto) throw new AppError('INTERNAL', 500, 'Could not serialize visit.');
    return dto;
  }

  /** Fresh row → host DTO; the shape every host mutation returns. */
  async function freshDto(visitId: string) {
    const row = await db.transaction().execute((trx) => findVisitById(trx, visitId));
    if (!row) throw new AppError('NOT_FOUND', 404, 'Visit not found.');
    return dtoFor(row);
  }

  // POST /v1/visits/preview — no write (SDD §12.6, F6 step 2; R-06/R-11 live hints).
  api.post(
    '/visits/preview',
    { schema: { body: CreateVisitBodySchema }, preHandler: requireAuth },
    async (request, reply) => {
      const principal = requireUser(request.principal);
      const resident = await residentOf(principal.userId);
      const deps = await depsFor(resident.hostel_id);
      reply.send(
        await previewVisit(deps, {
          principal,
          hostUserId: principal.userId,
          hostelId: resident.hostel_id,
          body: request.body,
        }),
      );
    },
  );

  // POST /v1/visits — pre-invite (FR-10, F1 step 1) or overnight request (FR-14, F6 step 3).
  api.post(
    '/visits',
    { schema: { body: CreateVisitBodySchema }, preHandler: requireAuth },
    async (request, reply) => {
      const principal = requireUser(request.principal);
      const resident = await residentOf(principal.userId);
      const deps = await depsFor(resident.hostel_id);
      const rulesConfig = deps.rulesConfig;
      const hostel = await db
        .selectFrom('haven.hostels')
        .select('gender_served')
        .where('id', '=', resident.hostel_id)
        .executeTakeFirstOrThrow();
      const hostelGender = hostel.gender_served as 'male' | 'female';
      const body = request.body;

      if (body.kind === 'invite') {
        const { visit, inviteToken } = await createPreInvite(deps, {
          principal,
          requestId: request.id,
          hostUserId: principal.userId,
          hostelId: resident.hostel_id,
          hostelGender,
          type: body.type,
          invitedName: body.guest.name,
          invitedPhone: body.guest.phone,
          invitedGender: body.guest.gender ?? null,
          windowStart: new Date(body.windowStart),
          windowEnd: new Date(body.windowEnd),
        });
        reply.status(201).send({
          visit: await dtoFor(visit),
          inviteUrl: `${opts.webBaseUrl.replace(/\/$/, '')}/i/${inviteToken}`,
        });
        return;
      }

      const { windowStart, windowEnd } = overnightWindow(
        rulesConfig,
        body.arrivalDate,
        body.departureDate,
      );
      const visit = await createOvernightRequest(deps, {
        principal,
        requestId: request.id,
        hostUserId: principal.userId,
        hostelId: resident.hostel_id,
        hostelGender,
        type: body.type,
        invitedName: body.guest.name,
        invitedPhone: body.guest.phone,
        invitedGender: body.guest.gender,
        windowStart,
        windowEnd,
        arrivalDate: body.arrivalDate,
        departureDate: body.departureDate,
        nights: nightsBetween(body.arrivalDate, body.departureDate).length,
      });
      // The invite link only exists once the warden approves (F6 step 5).
      reply.status(201).send({ visit: await dtoFor(visit) });
    },
  );

  // GET /v1/me/hosted-visits?bucket=upcoming|inside|history (FR-16, R-13, R-05).
  api.get(
    '/me/hosted-visits',
    { schema: { querystring: HostedVisitsQuerySchema }, preHandler: requireAuth },
    async (request, reply) => {
      const principal = requireUser(request.principal);
      authorize(principal, 'me.read', { ownerType: 'user', ownerId: principal.userId });
      const offset = decodeCursor(request.query.cursor);
      const limit = request.query.limit;
      let query = db.selectFrom('haven.visits').selectAll().where('host_id', '=', principal.userId);
      switch (request.query.bucket) {
        case 'upcoming':
          query = query
            .where('status', 'in', ['pending_host', 'pending_warden', 'approved'])
            .orderBy('window_start', 'asc');
          break;
        case 'inside':
          query = query.where('status', '=', 'inside').orderBy('last_entry_at', 'desc');
          break;
        case 'history':
          query = query
            .where('status', 'in', ['completed', 'rejected', 'expired', 'cancelled'])
            .orderBy('window_start', 'desc');
          break;
        default:
          query = query.orderBy('window_start', 'desc');
      }
      const rows = await query
        .orderBy('id')
        .offset(offset)
        .limit(limit + 1)
        .execute();
      const page = pageOf(rows, offset, limit);
      reply.send({
        items: await buildHostVisitDtos(dtoDeps, page.items),
        nextCursor: page.nextCursor,
      });
    },
  );

  // GET /v1/visits/:id — host/warden: VisitDTO + events[] (SDD §12.6); guest: status view.
  api.get(
    '/visits/:id',
    { schema: { params: VISIT_ID_PARAMS }, preHandler: requireAuth },
    async (request, reply) => {
      const visit = await visibleVisit(request.principal, request.params.id);

      if (request.principal?.type === 'visitor') {
        const host = await db
          .selectFrom('haven.users')
          .select('full_name')
          .where('id', '=', visit.host_id)
          .executeTakeFirstOrThrow();
        const hostel = await db
          .selectFrom('haven.hostels')
          .select('name')
          .where('id', '=', visit.hostel_id)
          .executeTakeFirstOrThrow();
        reply.send({
          ...visitDto(visit),
          hostFirstName: host.full_name.split(' ')[0],
          hostelName: hostel.name,
        });
        return;
      }

      const dto = await dtoFor(visit);
      const detail: VisitDetailDTO = { ...dto, events: await buildVisitEvents(dtoDeps, visit) };
      // CLAUDE.md §4: viewing a visit detail with photos is audited (threat T15).
      const principal = requireUser(request.principal);
      await db
        .insertInto('haven.audit_log')
        .values({
          actor_type: 'user',
          actor_id: principal.userId,
          hostel_id: visit.hostel_id,
          action: 'read.visit',
          entity: 'visits',
          entity_id: visit.id,
          before: null,
          after: null,
          ip: request.ip ?? null,
          request_id: request.id,
        })
        .execute();
      reply.send(detail);
    },
  );

  // PATCH /v1/visits/:id — host edits the window before entry (FR-13).
  api.patch(
    '/visits/:id',
    { schema: { params: VISIT_ID_PARAMS, body: PatchVisitBodySchema }, preHandler: requireAuth },
    async (request, reply) => {
      const principal = requireUser(request.principal);
      const visit = await visibleVisit(principal, request.params.id);
      const deps = await depsFor(visit.hostel_id);
      const updated = await editVisitWindow(deps, {
        principal,
        requestId: request.id,
        visitId: request.params.id,
        windowStart: request.body.windowStart ? new Date(request.body.windowStart) : undefined,
        windowEnd: request.body.windowEnd ? new Date(request.body.windowEnd) : undefined,
      });
      reply.send(await dtoFor(updated));
    },
  );

  // POST /v1/visits/:id/cancel — host cancels before check-in (FR-13).
  api.post(
    '/visits/:id/cancel',
    { schema: { params: VISIT_ID_PARAMS, body: CancelBodySchema }, preHandler: requireAuth },
    async (request, reply) => {
      const principal = requireUser(request.principal);
      const visit = await visibleVisit(principal, request.params.id);
      const deps = await depsFor(visit.hostel_id);
      if (visit.status === 'pending_warden') {
        await cancelOvernightRequest(deps, { principal, requestId: request.id, visitId: visit.id });
      } else if (visit.status === 'approved' && visit.first_entry_at === null) {
        await cancelApprovedVisit(deps, {
          principal,
          requestId: request.id,
          visitId: visit.id,
          reason: request.body.reason,
        });
      } else {
        throw new AppError('INVALID_TRANSITION', 409, 'This visit can no longer be cancelled.');
      }
      reply.send(await freshDto(visit.id));
    },
  );

  // POST /v1/visits/:id/invite-link — new link, old one invalidated (SDD §9.6).
  api.post(
    '/visits/:id/invite-link',
    { schema: { params: VISIT_ID_PARAMS }, preHandler: requireAuth },
    async (request, reply) => {
      const principal = requireUser(request.principal);
      const visit = await visibleVisit(principal, request.params.id);
      const deps = await depsFor(visit.hostel_id);
      const { inviteToken } = await regenerateInviteLink(deps, {
        principal,
        requestId: request.id,
        visitId: request.params.id,
      });
      reply.send({ inviteUrl: `${opts.webBaseUrl.replace(/\/$/, '')}/i/${inviteToken}` });
    },
  );

  // POST /v1/visits/:id/approve ★ — host (walk-in, R-08) or warden (overnight).
  api.post(
    '/visits/:id/approve',
    { schema: { params: VISIT_ID_PARAMS, body: ApproveBodySchema }, preHandler: requireAuth },
    async (request, reply) => {
      // A replayed response is still a read of this visit: check access first, so a
      // replay never skips authorize() (SECURITY-AUDIT SA-15). Only people act here.
      if (!request.principal || request.principal.type === 'device') {
        throw new AppError('AUTH_REQUIRED', 401, 'Sign in required.');
      }
      await visibleVisit(request.principal, request.params.id);
      await runIdempotent(db, request, reply, async () => {
        const visit = await visibleVisit(request.principal, request.params.id);
        const deps = await depsFor(visit.hostel_id);
        if (visit.status === 'pending_warden') {
          await approveOvernight(deps, {
            principal: request.principal,
            requestId: request.id,
            visitId: visit.id,
          });
        } else {
          // Not pending_host either → approveWalkIn's state machine check answers 409.
          const session = await findWalkInSessionForVisit(db, visit.id);
          const gate: WalkInGateContext = session
            ? {
                gateId: session.gate_id,
                scanSessionId: session.id,
                judgedAt: session.created_at,
                locationVerified: session.gps_ok,
                distanceM: session.distance_m,
                accuracyM: session.accuracy_m,
                photoMediaId: session.photo_media_id,
              }
            : { gateId: await anyGateOf(visit.hostel_id), locationVerified: false };
          await approveWalkIn(deps, {
            principal: request.principal,
            requestId: request.id,
            visitId: visit.id,
            gate,
            windowEnd: request.body.windowEnd ? new Date(request.body.windowEnd) : undefined,
          });
        }
        return { status: 200, body: await freshDto(visit.id) };
      });
    },
  );

  // POST /v1/visits/:id/reject ★ — host (walk-in) or warden (overnight, reason required).
  api.post(
    '/visits/:id/reject',
    { schema: { params: VISIT_ID_PARAMS, body: RejectBodySchema }, preHandler: requireAuth },
    async (request, reply) => {
      // A replayed response is still a read of this visit: check access first, so a
      // replay never skips authorize() (SECURITY-AUDIT SA-15). Only people act here.
      if (!request.principal || request.principal.type === 'device') {
        throw new AppError('AUTH_REQUIRED', 401, 'Sign in required.');
      }
      await visibleVisit(request.principal, request.params.id);
      await runIdempotent(db, request, reply, async () => {
        const visit = await visibleVisit(request.principal, request.params.id);
        const deps = await depsFor(visit.hostel_id);
        if (visit.status === 'pending_warden') {
          await rejectOvernight(deps, {
            principal: request.principal,
            requestId: request.id,
            visitId: visit.id,
            reason: request.body.reason,
          });
        } else {
          await rejectWalkIn(deps, {
            principal: request.principal,
            requestId: request.id,
            visitId: visit.id,
            reason: request.body.reason,
          });
        }
        return { status: 200, body: await freshDto(visit.id) };
      });
    },
  );

  // POST /v1/visits/:id/confirm-arrival ★ — F3 confirm / R-09 "Yes, that's my guest".
  api.post(
    '/visits/:id/confirm-arrival',
    { schema: { params: VISIT_ID_PARAMS }, preHandler: requireAuth },
    async (request, reply) => {
      // A replayed response is still a read of this visit: check access first, so a
      // replay never skips authorize() (SECURITY-AUDIT SA-15). Only people act here.
      if (!request.principal || request.principal.type === 'device') {
        throw new AppError('AUTH_REQUIRED', 401, 'Sign in required.');
      }
      await visibleVisit(request.principal, request.params.id);
      await runIdempotent(db, request, reply, async () => {
        const principal = requireUser(request.principal);
        const visit = await visibleVisit(principal, request.params.id);
        const deps = await depsFor(visit.hostel_id);
        await confirmArrival(deps, {
          principal,
          requestId: request.id,
          visitId: request.params.id,
        });
        return { status: 200, body: await freshDto(request.params.id) };
      });
    },
  );

  // POST /v1/visits/:id/dispute ★ — R-09 "Not my guest" (FR-43, F9).
  api.post(
    '/visits/:id/dispute',
    { schema: { params: VISIT_ID_PARAMS, body: DisputeBodySchema }, preHandler: requireAuth },
    async (request, reply) => {
      // A replayed response is still a read of this visit: check access first, so a
      // replay never skips authorize() (SECURITY-AUDIT SA-15). Only people act here.
      if (!request.principal || request.principal.type === 'device') {
        throw new AppError('AUTH_REQUIRED', 401, 'Sign in required.');
      }
      await visibleVisit(request.principal, request.params.id);
      await runIdempotent(db, request, reply, async () => {
        const principal = requireUser(request.principal);
        const visit = await visibleVisit(principal, request.params.id);
        const deps = await depsFor(visit.hostel_id);
        await disputeArrival(deps, {
          principal,
          requestId: request.id,
          visitId: request.params.id,
          note: request.body.note,
        });
        return { status: 200, body: await freshDto(request.params.id) };
      });
    },
  );

  // POST /v1/visits/:id/mark-left ★ — R-10 "My guest has left" (FR-45, F10).
  api.post(
    '/visits/:id/mark-left',
    { schema: { params: VISIT_ID_PARAMS }, preHandler: requireAuth },
    async (request, reply) => {
      // A replayed response is still a read of this visit: check access first, so a
      // replay never skips authorize() (SECURITY-AUDIT SA-15). Only people act here.
      if (!request.principal || request.principal.type === 'device') {
        throw new AppError('AUTH_REQUIRED', 401, 'Sign in required.');
      }
      await visibleVisit(request.principal, request.params.id);
      await runIdempotent(db, request, reply, async () => {
        const principal = requireUser(request.principal);
        const visit = await visibleVisit(principal, request.params.id);
        const deps = await depsFor(visit.hostel_id);
        await hostMarksGuestLeft(deps, {
          principal,
          requestId: request.id,
          visitId: request.params.id,
        });
        return { status: 200, body: await freshDto(request.params.id) };
      });
    },
  );

  // POST /v1/me/visits/:id/cancel — visitor cancels their own pending walk-in (SDD §12.7).
  api.post(
    '/me/visits/:id/cancel',
    { schema: { params: VISIT_ID_PARAMS }, preHandler: requireAuth },
    async (request, reply) => {
      if (!request.principal || request.principal.type !== 'visitor') {
        throw new AppError('AUTH_REQUIRED', 401, 'Sign in as a guest to cancel a request.');
      }
      const visit = await visibleVisit(request.principal, request.params.id);
      const deps = await depsFor(visit.hostel_id);
      const updated = await cancelWalkIn(deps, {
        principal: request.principal,
        requestId: request.id,
        visitId: request.params.id,
      });
      reply.send(visitDto(updated));
    },
  );

  // GET /v1/me/quota?month=YYYY-MM (SDD §12.5).
  api.get(
    '/me/quota',
    { schema: { querystring: QuotaQuerySchema }, preHandler: requireAuth },
    async (request, reply) => {
      const principal = requireUser(request.principal);
      authorize(principal, 'me.read', { ownerType: 'user', ownerId: principal.userId });
      const resident = await residentOf(principal.userId);
      const deps = await depsFor(resident.hostel_id);
      const month =
        request.query.month ??
        toLocalDateString(clock.now(), deps.rulesConfig.timezone).slice(0, 7);
      reply.send(await quotaFor(deps, principal.userId, month));
    },
  );

  // GET /v1/me/charges?status (SDD §12.5, R-14).
  api.get(
    '/me/charges',
    { schema: { querystring: ChargesQuerySchema }, preHandler: requireAuth },
    async (request, reply) => {
      const principal = requireUser(request.principal);
      authorize(principal, 'me.read', { ownerType: 'user', ownerId: principal.userId });
      await residentOf(principal.userId);
      const offset = decodeCursor(request.query.cursor);
      const limit = request.query.limit;
      let query = db
        .selectFrom('haven.charges')
        .select([
          'id',
          'kind',
          'amount_inr',
          'description',
          'status',
          'visit_id',
          'created_at',
          'receipt_no',
        ])
        .where('resident_id', '=', principal.userId);
      if (request.query.status) query = query.where('status', '=', request.query.status);
      const rows = await query
        .orderBy('created_at', 'desc')
        .orderBy('id')
        .offset(offset)
        .limit(limit + 1)
        .execute();
      const page = pageOf(rows, offset, limit);
      const items: ChargeDTO[] = page.items.map((c) => ({
        id: c.id,
        kind: c.kind,
        amountInr: c.amount_inr,
        description: c.description,
        status: c.status,
        visitId: c.visit_id,
        createdAt: c.created_at.toISOString(),
        receiptNo: c.receipt_no,
      }));
      reply.send({ items, nextCursor: page.nextCursor });
    },
  );

  async function anyGateOf(hostelId: string): Promise<string> {
    const gate = await db
      .selectFrom('haven.gates')
      .select('id')
      .where('hostel_id', '=', hostelId)
      .executeTakeFirst();
    if (!gate) throw new AppError('INTERNAL', 500, 'This hostel has no gate.');
    return gate.id;
  }
}
