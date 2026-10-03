import type { FastifyInstance } from 'fastify';
import type { Kysely } from 'kysely';
import { z } from 'zod';
import { GH8_RULES_CONFIG_V1 } from '@haven/shared';
import type { ZodTypeProvider } from '../lib/validation.js';
import type { Database } from '../db/index.js';
import type { Clock } from '../lib/clock.js';
import { AppError } from '../lib/errors.js';
import { sha256 } from '../lib/crypto.js';
import { requireAuth } from '../auth/authenticate.js';
import { authorize } from '../auth/policy.js';
import { checkIn, checkOut, createWalkIn, type VisitServiceDeps } from './service.js';
import { haversineDistanceMeters } from './geo.js';

/**
 * HTTP routes for the guest web golden path (SDD §12.5-ish visits endpoints — this
 * milestone adds only what the guest web app needs: invite landing, visit status,
 * check-in, check-out, and a minimal walk-in path). The full visits API surface
 * (host-side create/edit/cancel, warden approvals, previews) is not built here — see
 * docs/TRACEABILITY.md.
 */

const WINDOW_TOKEN_PARAMS = z.object({ token: z.string().min(1) });
const VISIT_ID_PARAMS = z.object({ id: z.string().uuid() });

const GateLocationBody = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  accuracyM: z.number().nonnegative().optional(),
});

const WalkInBody = z.object({
  hostUserId: z.string().uuid(),
  type: z.enum(['day', 'quick_drop']),
  guestGender: z.enum(['male', 'female', 'undisclosed']).nullable(),
  durationMinutes: z
    .number()
    .int()
    .positive()
    .max(14 * 60),
});

const RoomSearchQuery = z.object({ hostelId: z.string().uuid(), number: z.string().min(1) });

/** `+919876543210` -> `+91•••••43210` — SDD G-01: "invited phone shown as hint" / masked. */
function maskPhone(phone: string): string {
  if (phone.length <= 7) return phone;
  return `${phone.slice(0, 3)}${'•'.repeat(phone.length - 8)}${phone.slice(-5)}`;
}

function visitDto(row: {
  id: string;
  code: string;
  status: string;
  type: string;
  zone: string;
  window_start: Date;
  window_end: Date;
  close_reason: string | null;
  first_entry_at: Date | null;
  last_exit_at: Date | null;
  location_unverified: boolean;
}) {
  return {
    id: row.id,
    code: row.code,
    status: row.status,
    type: row.type,
    zone: row.zone,
    windowStart: row.window_start.toISOString(),
    windowEnd: row.window_end.toISOString(),
    closeReason: row.close_reason,
    firstEntryAt: row.first_entry_at?.toISOString() ?? null,
    lastExitAt: row.last_exit_at?.toISOString() ?? null,
    locationUnverified: row.location_unverified,
  };
}

export interface VisitRoutesOptions {
  db: Kysely<Database>;
  clock: Clock;
}

export async function registerVisitRoutes(
  app: FastifyInstance,
  opts: VisitRoutesOptions,
): Promise<void> {
  const { db, clock } = opts;
  const deps: VisitServiceDeps = { db, clock, rulesConfig: GH8_RULES_CONFIG_V1, rulesVersion: 1 };
  const api = app.withTypeProvider<ZodTypeProvider>();

  // GET /v1/invites/:token — public (SDD §12.7 / G-01 invite landing).
  api.get(
    '/invites/:token',
    { schema: { params: WINDOW_TOKEN_PARAMS } },
    async (request, reply) => {
      const tokenHash = sha256(request.params.token);
      const row = await db
        .selectFrom('haven.visits')
        .innerJoin('haven.users', 'haven.users.id', 'haven.visits.host_id')
        .innerJoin('haven.hostels', 'haven.hostels.id', 'haven.visits.hostel_id')
        .select([
          'haven.visits.id',
          'haven.visits.status',
          'haven.visits.type',
          'haven.visits.window_start',
          'haven.visits.window_end',
          'haven.visits.invited_phone',
          'haven.visits.visitor_id',
          'haven.users.full_name as host_full_name',
          'haven.hostels.name as hostel_name',
        ])
        .where('haven.visits.invite_token_hash', '=', tokenHash)
        .executeTakeFirst();

      if (!row) {
        throw new AppError('NOT_FOUND', 404, 'This invite link is not valid.');
      }

      reply.send({
        hostFirstName: row.host_full_name.split(' ')[0],
        hostelName: row.hostel_name,
        type: row.type,
        windowStart: row.window_start.toISOString(),
        windowEnd: row.window_end.toISOString(),
        invitedPhoneMasked: row.invited_phone ? maskPhone(row.invited_phone) : null,
        status: row.status,
        claimed: row.visitor_id !== null,
      });
    },
  );

  // GET /v1/visits/:id — visit status (G-07/G-12/G-14/G-17).
  api.get(
    '/visits/:id',
    { schema: { params: VISIT_ID_PARAMS }, preHandler: requireAuth },
    async (request, reply) => {
      const row = await db
        .selectFrom('haven.visits')
        .selectAll()
        .where('id', '=', request.params.id)
        .executeTakeFirst();
      if (!row) throw new AppError('NOT_FOUND', 404, 'Visit not found.');
      authorize(request.principal, 'visits.read', {
        hostelId: row.hostel_id,
        hostUserId: row.host_id,
        visitorId: row.visitor_id,
      });
      const hostRow = await db
        .selectFrom('haven.users')
        .select('full_name')
        .where('id', '=', row.host_id)
        .executeTakeFirstOrThrow();
      const hostelRow = await db
        .selectFrom('haven.hostels')
        .select('name')
        .where('id', '=', row.hostel_id)
        .executeTakeFirstOrThrow();
      reply.send({
        ...visitDto(row),
        hostFirstName: hostRow.full_name.split(' ')[0],
        hostelName: hostelRow.name,
      });
    },
  );

  // POST /v1/visits/:id/check-in (G-07/G-10 -> G-12).
  api.post(
    '/visits/:id/check-in',
    { schema: { params: VISIT_ID_PARAMS, body: GateLocationBody }, preHandler: requireAuth },
    async (request, reply) => {
      const gate = await resolveGateAndVerify(db, request.params.id, request.body);
      const updated = await checkIn(deps, {
        principal: request.principal,
        requestId: request.id,
        visitId: request.params.id,
        gate,
      });
      reply.send(visitDto(updated));
    },
  );

  // POST /v1/visits/:id/check-out (G-14 -> G-18).
  api.post(
    '/visits/:id/check-out',
    { schema: { params: VISIT_ID_PARAMS, body: GateLocationBody }, preHandler: requireAuth },
    async (request, reply) => {
      const gate = await resolveGateAndVerify(db, request.params.id, request.body);
      const updated = await checkOut(deps, {
        principal: request.principal,
        requestId: request.id,
        visitId: request.params.id,
        gate,
      });
      reply.send(visitDto(updated));
    },
  );

  // GET /v1/me/visits — G-17 "My visits" (today/upcoming/history cards, SDD §13.4).
  api.get('/me/visits', { preHandler: requireAuth }, async (request, reply) => {
    if (!request.principal || request.principal.type !== 'visitor') {
      throw new AppError('AUTH_REQUIRED', 401, 'Sign in required.');
    }
    const rows = await db
      .selectFrom('haven.visits')
      .innerJoin('haven.users', 'haven.users.id', 'haven.visits.host_id')
      .innerJoin('haven.hostels', 'haven.hostels.id', 'haven.visits.hostel_id')
      .select([
        'haven.visits.id',
        'haven.visits.code',
        'haven.visits.status',
        'haven.visits.type',
        'haven.visits.zone',
        'haven.visits.window_start',
        'haven.visits.window_end',
        'haven.visits.close_reason',
        'haven.visits.first_entry_at',
        'haven.visits.last_exit_at',
        'haven.visits.location_unverified',
        'haven.users.full_name as host_full_name',
        'haven.hostels.name as hostel_name',
      ])
      .where('haven.visits.visitor_id', '=', request.principal.visitorId)
      .orderBy('haven.visits.window_start', 'desc')
      .execute();
    reply.send(
      rows.map((row) => ({
        ...visitDto(row),
        hostFirstName: row.host_full_name.split(' ')[0],
        hostelName: row.hostel_name,
      })),
    );
  });

  // GET /v1/hostels — public (SDD §12.4 table: "GET /hostels Public -> [{id, code, name}]").
  api.get('/hostels', async (_request, reply) => {
    const rows = await db.selectFrom('haven.hostels').select(['id', 'code', 'name']).execute();
    reply.send(rows);
  });

  // GET /v1/rooms/search — G-08 "find your host".
  api.get('/rooms/search', { schema: { querystring: RoomSearchQuery } }, async (request, reply) => {
    const rows = await db
      .selectFrom('haven.residents')
      .innerJoin('haven.users', 'haven.users.id', 'haven.residents.user_id')
      .select(['haven.users.id', 'haven.users.full_name'])
      .where('haven.residents.hostel_id', '=', request.query.hostelId)
      .where('haven.residents.claimed_room', '=', request.query.number)
      .where('haven.residents.status', '=', 'verified')
      .execute();
    reply.send(rows.map((r) => ({ userId: r.id, fullName: r.full_name })));
  });

  // POST /v1/visits/walk-in — G-09 submit (SDD F2, simplified: no live scan session).
  api.post(
    '/visits/walk-in',
    { schema: { body: WalkInBody }, preHandler: requireAuth },
    async (request, reply) => {
      if (!request.principal || request.principal.type !== 'visitor') {
        throw new AppError('AUTH_REQUIRED', 401, 'Sign in as a guest to request a visit.');
      }
      const hostResident = await db
        .selectFrom('haven.residents')
        .select('hostel_id')
        .where('user_id', '=', request.body.hostUserId)
        .executeTakeFirst();
      if (!hostResident) throw new AppError('NOT_FOUND', 404, 'Host not found.');

      const now = clock.now();
      const windowEnd = new Date(now.getTime() + request.body.durationMinutes * 60_000);
      const visit = await createWalkIn(deps, {
        principal: request.principal,
        requestId: request.id,
        visitorId: request.principal.visitorId,
        hostUserId: request.body.hostUserId,
        hostelId: hostResident.hostel_id,
        hostelGender: GH8_RULES_CONFIG_V1.hostel_gender,
        type: request.body.type,
        guestGender: request.body.guestGender,
        windowStart: now,
        windowEnd,
      });
      reply.status(201).send(visitDto(visit));
    },
  );
}

async function resolveGateAndVerify(
  db: Kysely<Database>,
  visitId: string,
  location: { lat: number; lng: number; accuracyM?: number },
): Promise<{
  gateId: string;
  locationVerified: boolean;
  distanceM?: number | null;
  accuracyM?: number | null;
}> {
  const visit = await db
    .selectFrom('haven.visits')
    .select('hostel_id')
    .where('id', '=', visitId)
    .executeTakeFirst();
  if (!visit) throw new AppError('NOT_FOUND', 404, 'Visit not found.');

  const gate = await db
    .selectFrom('haven.gates')
    .select(['id', 'lat', 'lng', 'radius_m'])
    .where('hostel_id', '=', visit.hostel_id)
    .where('is_active', '=', true)
    .executeTakeFirst();
  if (!gate) throw new AppError('GATE_NOT_CONFIGURED', 503, 'This hostel has no gate set up yet.');

  let locationVerified = false;
  let distanceM: number | null = null;
  if (gate.lat !== null && gate.lng !== null) {
    distanceM = haversineDistanceMeters({ lat: gate.lat, lng: gate.lng }, location);
    locationVerified = distanceM <= gate.radius_m;
  }

  return { gateId: gate.id, locationVerified, distanceM, accuracyM: location.accuracyM ?? null };
}
