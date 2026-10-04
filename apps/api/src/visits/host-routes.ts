import type { FastifyInstance } from 'fastify';
import type { Kysely } from 'kysely';
import { z } from 'zod';
import { GH8_RULES_CONFIG_V1 } from '@haven/shared';
import type { ZodTypeProvider } from '../lib/validation.js';
import type { Database } from '../db/index.js';
import type { Clock } from '../lib/clock.js';
import { AppError } from '../lib/errors.js';
import { requireAuth } from '../auth/authenticate.js';
import {
  approveOvernight,
  approveWalkIn,
  cancelWalkIn,
  createPreInvite,
  rejectOvernight,
  rejectWalkIn,
  type VisitServiceDeps,
  type WalkInGateContext,
} from './service.js';
import { findWalkInSessionForVisit } from '../gate/scanSessions.js';
import { visitDto } from './routes.js';

/**
 * Host-facing visits routes (SDD §12.6): creating a pre-invite and acting on a
 * pending request. Minimal slice for the demo milestone — only what R-06/R-07/R-08/
 * R-13 need; the full host surface (preview, edit window, cancel, dispute, mark-left)
 * stays unbuilt (see docs/TRACEABILITY.md).
 */

const VISIT_ID_PARAMS = z.object({ id: z.string().uuid() });

const CreateVisitBody = z.object({
  kind: z.enum(['invite', 'overnight']),
  guest: z.object({
    name: z.string().min(1),
    phone: z
      .string()
      .regex(/^\+91[6-9][0-9]{9}$/)
      .nullable()
      .optional(),
    gender: z.enum(['male', 'female', 'undisclosed']).nullable().optional(),
  }),
  type: z.enum(['quick_drop', 'day', 'overnight_room', 'guest_room']),
  windowStart: z.string().datetime().optional(),
  windowEnd: z.string().datetime().optional(),
  arrivalDate: z.string().optional(),
  departureDate: z.string().optional(),
});

const ApproveBody = z.object({ windowEnd: z.string().datetime().optional() });
const RejectBody = z.object({ reason: z.string().optional() });

export interface HostVisitRoutesOptions {
  db: Kysely<Database>;
  clock: Clock;
}

export async function registerHostVisitRoutes(
  app: FastifyInstance,
  opts: HostVisitRoutesOptions,
): Promise<void> {
  const { db, clock } = opts;
  const deps: VisitServiceDeps = { db, clock, rulesConfig: GH8_RULES_CONFIG_V1, rulesVersion: 1 };
  const api = app.withTypeProvider<ZodTypeProvider>();

  async function requireVerifiedHost(userId: string) {
    const resident = await db
      .selectFrom('haven.residents')
      .select(['hostel_id', 'status'])
      .where('user_id', '=', userId)
      .executeTakeFirst();
    if (!resident || resident.status !== 'verified') {
      throw new AppError('FORBIDDEN', 403, 'Only a verified resident can do this.');
    }
    return resident;
  }

  // POST /v1/visits — host creates a pre-invite (SDD §12.6, F1 step 1). Overnight
  // (warden-approved) requests are out of scope for this demo slice — only "invite" is wired.
  api.post(
    '/visits',
    { schema: { body: CreateVisitBody }, preHandler: requireAuth },
    async (request, reply) => {
      if (!request.principal || request.principal.type !== 'user') {
        throw new AppError('AUTH_REQUIRED', 401, 'Sign in as a resident to create a visit.');
      }
      if (request.body.kind !== 'invite') {
        throw new AppError('VALIDATION_FAILED', 400, 'Only invite creation is implemented.');
      }
      if (!request.body.windowStart || !request.body.windowEnd) {
        throw new AppError('VALIDATION_FAILED', 400, 'windowStart and windowEnd are required.');
      }
      // An invite's visitor_id is null until claimed — `haven.visits`' own check
      // constraint requires invited_phone + invited_name in that case (matching
      // FR-12: the guest signs in with exactly this phone to claim it).
      if (!request.body.guest.phone) {
        throw new AppError('VALIDATION_FAILED', 400, 'guest.phone is required for an invite.');
      }
      const resident = await requireVerifiedHost(request.principal.userId);

      const { visit, inviteToken } = await createPreInvite(deps, {
        principal: request.principal,
        requestId: request.id,
        hostUserId: request.principal.userId,
        hostelId: resident.hostel_id,
        hostelGender: GH8_RULES_CONFIG_V1.hostel_gender,
        type: request.body.type as 'day' | 'quick_drop',
        invitedName: request.body.guest.name,
        invitedPhone: request.body.guest.phone ?? null,
        invitedGender: request.body.guest.gender ?? null,
        windowStart: new Date(request.body.windowStart),
        windowEnd: new Date(request.body.windowEnd),
      });

      const webBaseUrl = process.env.WEB_BASE_URL ?? 'http://localhost:8081';
      reply.status(201).send({
        visit: visitDto(visit),
        inviteUrl: `${webBaseUrl}/i/${inviteToken}`,
      });
    },
  );

  // GET /v1/me/hosted-visits — host's own visits (SDD §12.6, R-13).
  api.get('/me/hosted-visits', { preHandler: requireAuth }, async (request, reply) => {
    if (!request.principal || request.principal.type !== 'user') {
      throw new AppError('AUTH_REQUIRED', 401, 'Sign in required.');
    }
    const rows = await db
      .selectFrom('haven.visits')
      .selectAll()
      .where('host_id', '=', request.principal.userId)
      .orderBy('window_start', 'desc')
      .execute();
    reply.send(rows.map((row) => visitDto(row)));
  });

  // POST /v1/visits/:id/approve ★ — host (walk-in) or warden (overnight) (SDD §12.6).
  api.post(
    '/visits/:id/approve',
    { schema: { params: VISIT_ID_PARAMS, body: ApproveBody }, preHandler: requireAuth },
    async (request, reply) => {
      const current = await db
        .selectFrom('haven.visits')
        .select(['id', 'status'])
        .where('id', '=', request.params.id)
        .executeTakeFirst();
      if (!current) throw new AppError('NOT_FOUND', 404, 'Visit not found.');

      if (current.status === 'pending_host') {
        const session = await findWalkInSessionForVisit(db, current.id);
        const gate: WalkInGateContext = session
          ? {
              gateId: session.gate_id,
              scanSessionId: session.id,
              locationVerified: session.gps_ok,
              distanceM: session.distance_m,
              accuracyM: session.accuracy_m,
              photoMediaId: session.photo_media_id,
            }
          : { gateId: '', locationVerified: false };
        const updated = await approveWalkIn(deps, {
          principal: request.principal,
          requestId: request.id,
          visitId: current.id,
          gate,
        });
        reply.send(visitDto(updated));
        return;
      }
      if (current.status === 'pending_warden') {
        const updated = await approveOvernight(deps, {
          principal: request.principal,
          requestId: request.id,
          visitId: current.id,
        });
        reply.send(visitDto(updated));
        return;
      }
      throw new AppError('INVALID_TRANSITION', 409, 'This visit is not awaiting approval.');
    },
  );

  // POST /v1/visits/:id/reject ★ — host (walk-in) or warden (overnight) (SDD §12.6).
  api.post(
    '/visits/:id/reject',
    { schema: { params: VISIT_ID_PARAMS, body: RejectBody }, preHandler: requireAuth },
    async (request, reply) => {
      const current = await db
        .selectFrom('haven.visits')
        .select(['id', 'status'])
        .where('id', '=', request.params.id)
        .executeTakeFirst();
      if (!current) throw new AppError('NOT_FOUND', 404, 'Visit not found.');

      if (current.status === 'pending_host') {
        const updated = await rejectWalkIn(deps, {
          principal: request.principal,
          requestId: request.id,
          visitId: current.id,
        });
        reply.send(visitDto(updated));
        return;
      }
      if (current.status === 'pending_warden') {
        const updated = await rejectOvernight(deps, {
          principal: request.principal,
          requestId: request.id,
          visitId: current.id,
          reason: request.body.reason,
        });
        reply.send(visitDto(updated));
        return;
      }
      throw new AppError('INVALID_TRANSITION', 409, 'This visit is not awaiting a decision.');
    },
  );

  // POST /v1/me/visits/:id/cancel — visitor cancels their own pending walk-in (SDD §12.4).
  api.post(
    '/me/visits/:id/cancel',
    { schema: { params: VISIT_ID_PARAMS }, preHandler: requireAuth },
    async (request, reply) => {
      if (!request.principal || request.principal.type !== 'visitor') {
        throw new AppError('AUTH_REQUIRED', 401, 'Sign in as a guest to cancel a request.');
      }
      const updated = await cancelWalkIn(deps, {
        principal: request.principal,
        requestId: request.id,
        visitId: request.params.id,
      });
      reply.send(visitDto(updated));
    },
  );
}
