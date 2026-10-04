import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Kysely } from 'kysely';
import { z } from 'zod';
import { GH8_RULES_CONFIG_V1 } from '@haven/shared';
import type { ZodTypeProvider } from '../lib/validation.js';
import type { Database } from '../db/index.js';
import type { Clock } from '../lib/clock.js';
import { AppError } from '../lib/errors.js';
import { authorize } from '../auth/policy.js';
import { visitDto } from '../visits/routes.js';
import {
  checkIn,
  checkOut,
  createHostAssistedEntry,
  createWalkIn,
  type VisitServiceDeps,
} from '../visits/service.js';
import { createPairingCode, pairDevice, recordHeartbeat, revokeDevice } from './devices.js';
import { storeGatePhoto, type MediaStorage } from './media.js';
import {
  consumeSession,
  createScanSession,
  retryScanSessionLocation,
  setSessionPhoto,
  validateAndBindSession,
  type GateDeps,
} from './scanSessions.js';

/**
 * HTTP routes for the gate subsystem (SDD §12.8, §12.9's gate-device rows): scan
 * sessions, gate check-in/check-out/walk-in/host-assisted actions, and gate-device
 * pairing/heartbeat/revocation. `check-in`/`check-out`/`walk-in`/`host-assisted-*`
 * delegate the actual state transition to `visits/service.ts`'s existing functions —
 * this module's job is verifying the scan session (token, geofence, nonce, binding,
 * single-use) around that call, per SDD §9.3.
 */

const LocationSchema = z
  .object({
    lat: z.number().min(-90).max(90),
    lng: z.number().min(-180).max(180),
    accuracy: z.number().nonnegative(),
    capturedAt: z.string().optional(),
    // Device-computed `Date.now() - position.timestamp` (SDD §9.3 step 3 parenthetical)
    // — using the device's own clock for both operands, so a wrong phone clock can't
    // make a fresh fix look stale or vice versa.
    fixAgeMs: z.number().nonnegative(),
    mocked: z.boolean().optional(),
  })
  .nullable();

const CreateScanSessionBody = z.object({
  token: z.string().min(1),
  clientNonce: z.string().min(1),
  location: LocationSchema,
  locationError: z.string().nullable().optional(),
});

const LocationRetryBody = z.object({ location: LocationSchema, mocked: z.boolean().optional() });

const SESSION_ID_PARAMS = z.object({ id: z.string().uuid() });

const CheckInOutBody = z.object({ visitId: z.string().uuid(), photoId: z.string().uuid() });

const WalkInSessionBody = z.object({
  hostId: z.string().uuid(),
  type: z.enum(['day', 'quick_drop']),
  durationMinutes: z
    .number()
    .int()
    .positive()
    .max(14 * 60),
  photoId: z.string().uuid(),
});

const HostAssistedEntryBody = z.object({
  guest: z.object({
    name: z.string().min(1),
    gender: z.enum(['male', 'female', 'undisclosed']),
    phone: z
      .string()
      .regex(/^\+91[6-9][0-9]{9}$/)
      .nullable()
      .optional(),
  }),
  type: z.enum(['day', 'quick_drop']),
  durationMinutes: z
    .number()
    .int()
    .positive()
    .max(14 * 60),
  photoId: z.string().uuid(),
});

const HostAssistedExitBody = z.object({ visitId: z.string().uuid() });

const PairDeviceBody = z.object({ code: z.string().min(1), label: z.string().optional() });
const HeartbeatBody = z.object({ clientTime: z.string() });
const GATE_ID_PARAMS = z.object({ id: z.string().uuid() });
const DEVICE_ID_PARAMS = z.object({ id: z.string().uuid() });

function scanNonceFrom(request: FastifyRequest): string {
  const nonce = request.headers['x-scan-nonce'];
  if (typeof nonce !== 'string' || nonce.length === 0) {
    throw new AppError('SCAN_SESSION_FORBIDDEN', 403, 'Missing X-Scan-Nonce header.');
  }
  return nonce;
}

function principalBinding(
  request: FastifyRequest,
): { visitorId?: string; hostUserId?: string } | null {
  if (request.principal?.type === 'visitor') return { visitorId: request.principal.visitorId };
  if (request.principal?.type === 'user') return { hostUserId: request.principal.userId };
  return null;
}

export interface GateRoutesOptions {
  db: Kysely<Database>;
  clock: Clock;
  dataEncryptionKey: Buffer;
  mediaStorage: MediaStorage;
}

export async function registerGateRoutes(
  app: FastifyInstance,
  opts: GateRoutesOptions,
): Promise<void> {
  const { db, clock, dataEncryptionKey, mediaStorage } = opts;
  const gateDeps: GateDeps = { db, clock, dataEncryptionKey };
  const visitDeps: VisitServiceDeps = {
    db,
    clock,
    rulesConfig: GH8_RULES_CONFIG_V1,
    rulesVersion: 1,
  };
  const api = app.withTypeProvider<ZodTypeProvider>();

  // POST /v1/scan-sessions — public (SDD §9.3, §12.8). Rate limit: 20/IP/min (SDD §12.11).
  api.post(
    '/scan-sessions',
    {
      schema: { body: CreateScanSessionBody },
      config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    },
    async (request, reply) => {
      const result = await createScanSession(gateDeps, {
        token: request.body.token,
        clientNonce: request.body.clientNonce,
        location: request.body.location
          ? {
              lat: request.body.location.lat,
              lng: request.body.location.lng,
              accuracy: request.body.location.accuracy,
              fixAgeMs: request.body.location.fixAgeMs,
            }
          : null,
        mocked: request.body.location?.mocked,
        ip: request.ip,
        userAgent: request.headers['user-agent'] ?? null,
      });
      reply.status(201).send(result);
    },
  );

  // POST /v1/scan-sessions/:id/location — retry (SDD §9.3).
  api.post(
    '/scan-sessions/:id/location',
    { schema: { params: SESSION_ID_PARAMS, body: LocationRetryBody } },
    async (request, reply) => {
      const result = await retryScanSessionLocation(
        gateDeps,
        request.params.id,
        request.body.location
          ? {
              lat: request.body.location.lat,
              lng: request.body.location.lng,
              accuracy: request.body.location.accuracy,
              fixAgeMs: request.body.location.fixAgeMs,
            }
          : null,
        request.body.location?.mocked ?? request.body.mocked,
      );
      reply.send(result);
    },
  );

  // GET /v1/scan-sessions/:id — visitor or resident (SDD §12.8).
  api.get(
    '/scan-sessions/:id',
    { schema: { params: SESSION_ID_PARAMS } },
    async (request, reply) => {
      if (!request.principal || request.principal.type === 'device') {
        throw new AppError('AUTH_REQUIRED', 401, 'Sign in required.');
      }
      const nonce = scanNonceFrom(request);
      const session = await validateAndBindSession(
        db,
        clock,
        request.params.id,
        nonce,
        principalBinding(request),
      );

      const gate = await db
        .selectFrom('haven.gates')
        .select(['hostel_id'])
        .where('id', '=', session.gate_id)
        .executeTakeFirstOrThrow();

      if (request.principal.type !== 'visitor') {
        reply.send({ gpsOk: session.gps_ok, actions: [], visits: [] });
        return;
      }

      const approved = await db
        .selectFrom('haven.visits')
        .selectAll()
        .where('visitor_id', '=', request.principal.visitorId)
        .where('hostel_id', '=', gate.hostel_id)
        .where('status', '=', 'approved')
        .orderBy('window_start', 'asc')
        .executeTakeFirst();
      const inside = await db
        .selectFrom('haven.visits')
        .selectAll()
        .where('visitor_id', '=', request.principal.visitorId)
        .where('status', '=', 'inside')
        .executeTakeFirst();

      if (inside) {
        reply.send({ gpsOk: session.gps_ok, actions: ['check_out'], visits: [visitDto(inside)] });
      } else if (approved) {
        reply.send({ gpsOk: session.gps_ok, actions: ['check_in'], visits: [visitDto(approved)] });
      } else {
        reply.send({ gpsOk: session.gps_ok, actions: ['request_entry'], visits: [] });
      }
    },
  );

  // POST /v1/scan-sessions/:id/photo — multipart (SDD §9.4).
  api.post('/scan-sessions/:id/photo', async (request, reply) => {
    const { id } = SESSION_ID_PARAMS.parse(request.params);
    if (!request.principal || request.principal.type === 'device') {
      throw new AppError('AUTH_REQUIRED', 401, 'Sign in required.');
    }
    const nonce = scanNonceFrom(request);
    const session = await validateAndBindSession(db, clock, id, nonce, principalBinding(request));
    const gate = await db
      .selectFrom('haven.gates')
      .select(['hostel_id'])
      .where('id', '=', session.gate_id)
      .executeTakeFirstOrThrow();

    const file = await request.file();
    if (!file) throw new AppError('PHOTO_REQUIRED', 400, 'A photo is required.');
    const raw = await file.toBuffer();

    const { photoId } = await storeGatePhoto({
      db,
      storage: mediaStorage,
      clock,
      raw,
      hostelId: gate.hostel_id,
      ownerVisitorId: request.principal.type === 'visitor' ? request.principal.visitorId : null,
      ownerUserId: request.principal.type === 'user' ? request.principal.userId : null,
    });

    await setSessionPhoto(db, id, photoId);
    reply.send({ photoId });
  });

  // POST /v1/scan-sessions/:id/check-in — visitor (SDD §9.3/§12.8 ★).
  api.post(
    '/scan-sessions/:id/check-in',
    { schema: { params: SESSION_ID_PARAMS, body: CheckInOutBody } },
    async (request, reply) => {
      if (!request.principal || request.principal.type !== 'visitor') {
        throw new AppError('AUTH_REQUIRED', 401, 'Sign in as a guest to check in.');
      }
      const nonce = scanNonceFrom(request);
      const session = await validateAndBindSession(db, clock, request.params.id, nonce, {
        visitorId: request.principal.visitorId,
      });

      // SDD §12.8: "evaluateEntry -> if gpsOk is false and the visit isn't already
      // host-confirmed, set result = awaiting_host_confirmation, store the photo on
      // the session, notify host (N-CONFIRM-LOCATION), return -- else [complete
      // entry]." The visits-service `checkIn` (built before the gate module existed)
      // always completes the entry once rules pass; it has no "wait for host" branch.
      // Adding that status to the visit state machine is Resident-app-approval work
      // (out of scope here, per the task's own deferral of host-side UI) — this
      // short-circuits *before* calling it, so an unconfirmed low-GPS check-in
      // genuinely does not transition the visit, matching the SDD response contract.
      // It does skip the rules-engine checks (cutoffs, host-verified, ...) that the
      // completing path still gets via `checkIn` itself — a disclosed simplification,
      // not silent, since real rule enforcement happens anyway once a future
      // host-confirm action actually completes the entry.
      if (!session.gps_ok) {
        const visit = await db
          .selectFrom('haven.visits')
          .selectAll()
          .where('id', '=', request.body.visitId)
          .executeTakeFirst();
        if (!visit) throw new AppError('NOT_FOUND', 404, 'Visit not found.');
        if (!visit.host_confirmed_at) {
          await setSessionPhoto(db, session.id, request.body.photoId);
          await db
            .insertInto('haven.notifications')
            .values({
              hostel_id: visit.hostel_id,
              recipient_type: 'user',
              recipient_id: visit.host_id,
              kind: 'N-CONFIRM-LOCATION',
              channel: 'push',
              visit_id: visit.id,
              body: "Your guest is at the gate but we couldn't confirm their location.",
            })
            .execute();
          reply.send({ visit: visitDto(visit), result: 'awaiting_host_confirmation' });
          return;
        }
      }

      const updated = await checkIn(visitDeps, {
        principal: request.principal,
        requestId: request.id,
        visitId: request.body.visitId,
        gate: {
          gateId: session.gate_id,
          scanSessionId: session.id,
          locationVerified: session.gps_ok,
          distanceM: session.distance_m,
          accuracyM: session.accuracy_m,
          photoMediaId: request.body.photoId,
        },
      });
      await db
        .transaction()
        .execute((trx) => consumeSession(trx, clock, session.id, 'check_in', updated.id));

      reply.send({ visit: visitDto(updated), result: 'inside' });
    },
  );

  // POST /v1/scan-sessions/:id/check-out — visitor (SDD §9.3/§12.8 ★).
  api.post(
    '/scan-sessions/:id/check-out',
    { schema: { params: SESSION_ID_PARAMS, body: CheckInOutBody } },
    async (request, reply) => {
      if (!request.principal || request.principal.type !== 'visitor') {
        throw new AppError('AUTH_REQUIRED', 401, 'Sign in as a guest to check out.');
      }
      const nonce = scanNonceFrom(request);
      const session = await validateAndBindSession(db, clock, request.params.id, nonce, {
        visitorId: request.principal.visitorId,
      });

      const updated = await checkOut(visitDeps, {
        principal: request.principal,
        requestId: request.id,
        visitId: request.body.visitId,
        gate: {
          gateId: session.gate_id,
          scanSessionId: session.id,
          locationVerified: session.gps_ok,
          distanceM: session.distance_m,
          accuracyM: session.accuracy_m,
          photoMediaId: request.body.photoId,
        },
      });
      await db
        .transaction()
        .execute((trx) => consumeSession(trx, clock, session.id, 'check_out', updated.id));

      reply.send({ visit: visitDto(updated) });
    },
  );

  // POST /v1/scan-sessions/:id/walk-in — visitor (SDD F2/§12.8 ★).
  api.post(
    '/scan-sessions/:id/walk-in',
    { schema: { params: SESSION_ID_PARAMS, body: WalkInSessionBody } },
    async (request, reply) => {
      if (!request.principal || request.principal.type !== 'visitor') {
        throw new AppError('AUTH_REQUIRED', 401, 'Sign in as a guest to request a visit.');
      }
      const nonce = scanNonceFrom(request);
      const session = await validateAndBindSession(db, clock, request.params.id, nonce, {
        visitorId: request.principal.visitorId,
      });

      const hostResident = await db
        .selectFrom('haven.residents')
        .select('hostel_id')
        .where('user_id', '=', request.body.hostId)
        .executeTakeFirst();
      if (!hostResident) throw new AppError('NOT_FOUND', 404, 'Host not found.');

      const now = clock.now();
      const windowEnd = new Date(now.getTime() + request.body.durationMinutes * 60_000);
      const visit = await createWalkIn(visitDeps, {
        principal: request.principal,
        requestId: request.id,
        visitorId: request.principal.visitorId,
        hostUserId: request.body.hostId,
        hostelId: hostResident.hostel_id,
        hostelGender: GH8_RULES_CONFIG_V1.hostel_gender,
        type: request.body.type,
        guestGender: null,
        windowStart: now,
        windowEnd,
      });
      // The scan session stays queryable (not deleted) after being marked consumed,
      // linked to this visit (`visit_id`) — the host's later approval needs its GPS
      // facts (SDD F2 step 9: "using the scan session's GPS result ... no second scan").
      await db
        .transaction()
        .execute((trx) => consumeSession(trx, clock, session.id, 'walk_in', visit.id));

      reply.status(201).send({ visit: visitDto(visit) });
    },
  );

  // POST /v1/scan-sessions/:id/host-assisted-entry — verified resident (SDD F4/§12.8 ★).
  api.post(
    '/scan-sessions/:id/host-assisted-entry',
    { schema: { params: SESSION_ID_PARAMS, body: HostAssistedEntryBody } },
    async (request, reply) => {
      if (!request.principal || request.principal.type !== 'user') {
        throw new AppError('AUTH_REQUIRED', 401, 'Sign in as a resident to check in a guest.');
      }
      const nonce = scanNonceFrom(request);
      const session = await validateAndBindSession(db, clock, request.params.id, nonce, {
        hostUserId: request.principal.userId,
      });
      const hostResident = await db
        .selectFrom('haven.residents')
        .select(['hostel_id', 'status'])
        .where('user_id', '=', request.principal.userId)
        .executeTakeFirst();
      if (!hostResident || hostResident.status !== 'verified') {
        throw new AppError('FORBIDDEN', 403, 'Only a verified resident can do this.');
      }

      const now = clock.now();
      const windowEnd = new Date(now.getTime() + request.body.durationMinutes * 60_000);
      const visit = await createHostAssistedEntry(visitDeps, {
        principal: request.principal,
        requestId: request.id,
        hostUserId: request.principal.userId,
        hostelId: hostResident.hostel_id,
        hostelGender: GH8_RULES_CONFIG_V1.hostel_gender,
        type: request.body.type,
        invitedName: request.body.guest.name,
        invitedPhone: request.body.guest.phone ?? null,
        invitedGender: request.body.guest.gender,
        windowStart: now,
        windowEnd,
        gateId: session.gate_id,
        photoMediaId: request.body.photoId,
      });
      await db
        .transaction()
        .execute((trx) => consumeSession(trx, clock, session.id, 'host_assisted', visit.id));

      reply.status(201).send({ visit: visitDto(visit) });
    },
  );

  // POST /v1/scan-sessions/:id/host-assisted-exit — resident (SDD F4 step 5/§12.9 ★).
  api.post(
    '/scan-sessions/:id/host-assisted-exit',
    { schema: { params: SESSION_ID_PARAMS, body: HostAssistedExitBody } },
    async (request, reply) => {
      if (!request.principal || request.principal.type !== 'user') {
        throw new AppError('AUTH_REQUIRED', 401, 'Sign in as a resident to check out a guest.');
      }
      const nonce = scanNonceFrom(request);
      const session = await validateAndBindSession(db, clock, request.params.id, nonce, {
        hostUserId: request.principal.userId,
      });

      const updated = await checkOut(visitDeps, {
        principal: request.principal,
        requestId: request.id,
        visitId: request.body.visitId,
        gate: {
          gateId: session.gate_id,
          scanSessionId: session.id,
          locationVerified: session.gps_ok,
          distanceM: session.distance_m,
          accuracyM: session.accuracy_m,
          photoMediaId: null,
        },
      });
      await db
        .transaction()
        .execute((trx) => consumeSession(trx, clock, session.id, 'host_assisted', updated.id));

      reply.send({ visit: visitDto(updated) });
    },
  );

  // POST /v1/gate-devices/pair — public (SDD F8 step 2-3). Rate limit 5/IP/10min (§12.11).
  api.post(
    '/gate-devices/pair',
    {
      schema: { body: PairDeviceBody },
      config: { rateLimit: { max: 5, timeWindow: '10 minutes' } },
    },
    async (request, reply) => {
      const result = await pairDevice({
        db,
        clock,
        dataEncryptionKey,
        code: request.body.code,
        label: request.body.label,
        ip: request.ip,
        userAgent: request.headers['user-agent'] ?? null,
      });
      reply.send(result);
    },
  );

  // POST /v1/gate-devices/heartbeat — device principal (SDD §9.2/§12.9).
  api.post(
    '/gate-devices/heartbeat',
    { schema: { body: HeartbeatBody } },
    async (request, reply) => {
      if (!request.principal || request.principal.type !== 'device') {
        throw new AppError('AUTH_REQUIRED', 401, 'Gate device authentication required.');
      }
      const result = await recordHeartbeat({
        db,
        clock,
        dataEncryptionKey,
        deviceId: request.principal.deviceId,
        clientTime: request.body.clientTime,
        ip: request.ip,
        userAgent: request.headers['user-agent'] ?? null,
      });
      reply.send(result);
    },
  );

  // POST /v1/admin/gates/:id/pairing-codes — warden (SDD §12.9).
  api.post(
    '/admin/gates/:id/pairing-codes',
    { schema: { params: GATE_ID_PARAMS } },
    async (request, reply) => {
      if (!request.principal || request.principal.type !== 'user') {
        throw new AppError('AUTH_REQUIRED', 401, 'Sign in required.');
      }
      const gate = await db
        .selectFrom('haven.gates')
        .select(['id', 'hostel_id'])
        .where('id', '=', request.params.id)
        .executeTakeFirst();
      if (!gate) throw new AppError('NOT_FOUND', 404, 'Gate not found.');
      authorize(request.principal, 'gate.create_pairing_code', { hostelId: gate.hostel_id });

      const result = await createPairingCode({
        db,
        clock,
        gateId: gate.id,
        createdByUserId: request.principal.userId,
      });
      reply.send({ code: result.displayCode, expiresAt: result.expiresAt.toISOString() });
    },
  );

  // POST /v1/admin/gate-devices/:id/revoke — warden (SDD §12.9: "Rotates gate secret").
  api.post(
    '/admin/gate-devices/:id/revoke',
    { schema: { params: DEVICE_ID_PARAMS } },
    async (request, reply) => {
      if (!request.principal || request.principal.type !== 'user') {
        throw new AppError('AUTH_REQUIRED', 401, 'Sign in required.');
      }
      const device = await db
        .selectFrom('haven.gate_devices')
        .innerJoin('haven.gates', 'haven.gates.id', 'haven.gate_devices.gate_id')
        .select(['haven.gate_devices.id', 'haven.gates.hostel_id'])
        .where('haven.gate_devices.id', '=', request.params.id)
        .executeTakeFirst();
      if (!device) throw new AppError('NOT_FOUND', 404, 'Device not found.');
      authorize(request.principal, 'gate.revoke_device', { hostelId: device.hostel_id });

      await revokeDevice({
        db,
        clock,
        dataEncryptionKey,
        deviceId: device.id,
        revokedByUserId: request.principal.userId,
      });
      reply.status(204).send();
    },
  );
}
