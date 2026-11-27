import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Kysely } from 'kysely';
import { z } from 'zod';
import type { ZodTypeProvider } from '../lib/validation.js';
import type { Database } from '../db/index.js';
import type { Clock } from '../lib/clock.js';
import { AppError } from '../lib/errors.js';
import { visitDto } from '../visits/routes.js';
import {
  checkIn,
  checkOut,
  createHostAssistedEntry,
  createWalkIn,
  type VisitServiceDeps,
} from '../visits/service.js';
import { requestHostLocationConfirmation } from '../visits/host-actions.js';
import type { RulesProvider } from '../rules/provider.js';
import { runIdempotent } from '../lib/idempotency.js';
import { pairDevice, recordHeartbeat } from './devices.js';
import { storeGatePhoto, type MediaStorage } from './media.js';
import { consumeScanSession } from './repository.js';
import { authorize } from '../auth/policy.js';
import { assertVisitorProfileComplete } from '../auth/visitor-service.js';
import { displayName, localDateTimeToUtc, plusDays, toLocalDateString } from '@haven/shared';
import {
  consumeSession,
  createScanSession,
  retryScanSessionLocation,
  setSessionPhoto,
  validateAndBindSession,
  type GateDeps,
} from './scanSessions.js';
import type { Env } from '../config.js';
import { assertPhoneAllowedHere } from '../auth/test-phones.js';

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

const LocationRetryBody = z.object({
  location: LocationSchema,
  locationError: z.string().nullable().optional(),
  mocked: z.boolean().optional(),
});

const SESSION_ID_PARAMS = z.object({ id: z.string().uuid() });
const RoomResidentsParams = z.object({
  id: z.string().uuid(),
  number: z.string().regex(/^[A-Za-z0-9-]{1,8}$/),
});

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
  webBaseUrl?: string;
  rules: RulesProvider;
  /** Staging registers guests with the SDD §9.5 test numbers only (DEC-028). */
  appEnv?: Env['APP_ENV'];
}

export async function registerGateRoutes(
  app: FastifyInstance,
  opts: GateRoutesOptions,
): Promise<void> {
  const { db, clock, dataEncryptionKey, mediaStorage } = opts;
  const gateDeps: GateDeps = { db, clock, dataEncryptionKey };
  /** Service deps with the rules of the hostel this gate belongs to (SDD §4, E-13). */
  async function depsForGate(gateId: string): Promise<VisitServiceDeps> {
    const gate = await db
      .selectFrom('haven.gates')
      .select('hostel_id')
      .where('id', '=', gateId)
      .executeTakeFirstOrThrow();
    const { config, version } = await opts.rules.forHostel(gate.hostel_id);
    return { db, clock, rulesConfig: config, rulesVersion: version, webBaseUrl: opts.webBaseUrl };
  }
  const api = app.withTypeProvider<ZodTypeProvider>();

  // POST /v1/scan-sessions — public (SDD §9.3, §12.8). Rate limit: 20/IP/min (SDD §12.11).
  api.post(
    '/scan-sessions',
    {
      schema: { body: CreateScanSessionBody },
      config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    },
    async (request, reply) => {
      authorize(request.principal ?? null, 'scan_sessions.create', {});
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
        locationError: request.body.locationError,
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
      // §12.1: "calls on /v1/scan-sessions/{id}/* require X-Scan-Nonce" — this one
      // didn't check it (found by the authorize() enforcement, SECURITY-AUDIT SA-15).
      await validateAndBindSession(
        db,
        clock,
        request.params.id,
        scanNonceFrom(request),
        principalBinding(request),
      );
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
        request.body.locationError,
      );
      reply.send(result);
    },
  );

  // GET /v1/scan-sessions/:id — visitor or resident (SDD §12.8).
  // GET /v1/hostels/:id/rooms/:number/residents — G-08 "find your host" (SDD §12.7):
  // "Visitor with live scan session, header X-Scan-Session ... [{ residentId,
  // displayName }] — verified residents only; rate-limited 10/min". The session must be
  // the caller's (its X-Scan-Nonce, bound to them) and at a gate of this hostel
  // (SECURITY-AUDIT SA-01: this replaced a public endpoint returning full names).
  api.get(
    '/hostels/:id/rooms/:number/residents',
    {
      schema: { params: RoomResidentsParams },
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    },
    async (request, reply) => {
      if (!request.principal || request.principal.type !== 'visitor') {
        throw new AppError('AUTH_REQUIRED', 401, 'Sign in required.');
      }
      const sessionId = request.headers['x-scan-session'];
      if (typeof sessionId !== 'string' || !/^[0-9a-f-]{36}$/i.test(sessionId)) {
        throw new AppError('SCAN_SESSION_FORBIDDEN', 403, 'Missing X-Scan-Session header.');
      }
      const session = await validateAndBindSession(
        db,
        clock,
        sessionId,
        scanNonceFrom(request),
        principalBinding(request),
      );
      const gate = await db
        .selectFrom('haven.gates')
        .select(['hostel_id'])
        .where('id', '=', session.gate_id)
        .executeTakeFirstOrThrow();
      authorize(request.principal, 'gate.search_residents', {
        sessionVisitorId: session.visitor_id,
        sessionHostelId: gate.hostel_id,
        hostelId: request.params.id,
      });

      const rows = await db
        .selectFrom('haven.residents')
        .innerJoin('haven.users', 'haven.users.id', 'haven.residents.user_id')
        .select(['haven.users.id', 'haven.users.full_name'])
        .where('haven.residents.hostel_id', '=', request.params.id)
        .where('haven.residents.claimed_room', '=', request.params.number.toUpperCase())
        .where('haven.residents.status', '=', 'verified')
        .execute();
      reply.send(rows.map((r) => ({ residentId: r.id, displayName: displayName(r.full_name) })));
    },
  );

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

      // FR-23: "an approved visit for today at this hostel" — today in the hostel's
      // timezone, and not already over. E-06: every such visit is listed (two hosts
      // can invite the same guest); the guest picks one. Only one can be inside.
      const { config } = await opts.rules.forHostel(gate.hostel_id);
      const now = clock.now();
      const tomorrowStart = localDateTimeToUtc(
        plusDays(toLocalDateString(now, config.timezone), 1, config.timezone),
        '00:00',
        config.timezone,
      );
      const approvedToday = await db
        .selectFrom('haven.visits')
        .selectAll()
        .where('visitor_id', '=', request.principal.visitorId)
        .where('hostel_id', '=', gate.hostel_id)
        .where('status', '=', 'approved')
        .where('window_start', '<', tomorrowStart)
        .where('window_end', '>', now)
        .orderBy('window_start', 'asc')
        .execute();
      const inside = await db
        .selectFrom('haven.visits')
        .selectAll()
        .where('visitor_id', '=', request.principal.visitorId)
        .where('status', '=', 'inside')
        .executeTakeFirst();

      // The gate page says "Visiting <host first name> until …" (G-08), as My visits does.
      const named = async (rows: (typeof approvedToday)[number][]) => {
        const hostIds = [...new Set(rows.map((r) => r.host_id))];
        const hostelIds = [...new Set(rows.map((r) => r.hostel_id))];
        const hosts = hostIds.length
          ? await db
              .selectFrom('haven.users')
              .select(['id', 'full_name'])
              .where('id', 'in', hostIds)
              .execute()
          : [];
        const hostels = hostelIds.length
          ? await db
              .selectFrom('haven.hostels')
              .select(['id', 'name'])
              .where('id', 'in', hostelIds)
              .execute()
          : [];
        return rows.map((r) => ({
          ...visitDto(r),
          hostFirstName: hosts.find((h) => h.id === r.host_id)?.full_name.split(' ')[0],
          hostelName: hostels.find((h) => h.id === r.hostel_id)?.name,
        }));
      };

      if (inside) {
        reply.send({
          gpsOk: session.gps_ok,
          actions: ['check_out'],
          visits: await named([inside]),
        });
      } else if (approvedToday.length > 0) {
        reply.send({
          gpsOk: session.gps_ok,
          actions: ['check_in'],
          visits: await named(approvedToday),
        });
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
      const principal = request.principal;
      // SDD §9.12 / E-10: a retried check-in replays the first answer; the session is
      // already consumed, so running it again would fail instead (TC-FLOW-10).
      await runIdempotent(db, request, reply, async () => {
        await assertVisitorProfileComplete(db, principal.visitorId);
        const nonce = scanNonceFrom(request);
        const session = await validateAndBindSession(db, clock, request.params.id, nonce, {
          visitorId: principal.visitorId,
        });
        const visitDeps = await depsForGate(session.gate_id);

        // SDD §12.8: "evaluateEntry -> if gpsOk is false and the visit isn't already
        // host-confirmed, set result = awaiting_host_confirmation, store the photo on
        // the session, notify host (N-CONFIRM-LOCATION), return". The visit stays
        // `approved` and the session is linked to it; the host's confirm-arrival
        // (`POST /visits/{id}/confirm-arrival`) completes the entry (SDD F3 step 4).
        if (!session.gps_ok) {
          const visit = await requestHostLocationConfirmation(visitDeps, {
            principal,
            requestId: request.id,
            visitId: request.body.visitId,
            scanSessionId: session.id,
            photoMediaId: request.body.photoId,
          });
          return {
            status: 200,
            body: { visit: visitDto(visit), result: 'awaiting_host_confirmation' },
          };
        }

        const updated = await checkIn(visitDeps, {
          principal,
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
          onEntered: (trx, entered) =>
            consumeScanSession(trx, session.id, 'check_in', clock.now(), entered.id),
        });

        return { status: 200, body: { visit: visitDto(updated), result: 'inside' } };
      });
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
      const principal = request.principal;
      await runIdempotent(db, request, reply, async () => {
        const nonce = scanNonceFrom(request);
        const session = await validateAndBindSession(db, clock, request.params.id, nonce, {
          visitorId: principal.visitorId,
        });
        const visitDeps = await depsForGate(session.gate_id);

        const updated = await checkOut(visitDeps, {
          principal,
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

        return { status: 200, body: { visit: visitDto(updated) } };
      });
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
      const principal = request.principal;
      await runIdempotent(db, request, reply, async () => {
        await assertVisitorProfileComplete(db, principal.visitorId);
        const nonce = scanNonceFrom(request);
        const session = await validateAndBindSession(db, clock, request.params.id, nonce, {
          visitorId: principal.visitorId,
        });
        const visitDeps = await depsForGate(session.gate_id);

        const hostResident = await db
          .selectFrom('haven.residents')
          .select('hostel_id')
          .where('user_id', '=', request.body.hostId)
          .executeTakeFirst();
        if (!hostResident) throw new AppError('NOT_FOUND', 404, 'Host not found.');

        const now = clock.now();
        const windowEnd = new Date(now.getTime() + request.body.durationMinutes * 60_000);
        const visit = await createWalkIn(visitDeps, {
          principal,
          requestId: request.id,
          visitorId: principal.visitorId,
          hostUserId: request.body.hostId,
          hostelId: hostResident.hostel_id,
          hostelGender: visitDeps.rulesConfig.hostel_gender,
          type: request.body.type,
          guestGender: null,
          windowStart: now,
          windowEnd,
          locationVerified: session.gps_ok,
        });
        // The scan session stays queryable (not deleted) after being marked consumed,
        // linked to this visit (`visit_id`) — the host's later approval needs its GPS
        // facts (SDD F2 step 9: "using the scan session's GPS result ... no second scan").
        await db
          .transaction()
          .execute((trx) => consumeSession(trx, clock, session.id, 'walk_in', visit.id));

        return { status: 201, body: { visit: visitDto(visit) } };
      });
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
      const principal = request.principal;
      await runIdempotent(db, request, reply, async () => {
        const nonce = scanNonceFrom(request);
        const session = await validateAndBindSession(db, clock, request.params.id, nonce, {
          hostUserId: principal.userId,
        });
        const visitDeps = await depsForGate(session.gate_id);
        const hostResident = await db
          .selectFrom('haven.residents')
          .select(['hostel_id'])
          .where('user_id', '=', principal.userId)
          .executeTakeFirst();
        // Not a resident at all: nothing to host from. A pending/suspended resident
        // is answered by the rules engine (HOST_NOT_VERIFIED / HOST_SUSPENDED, 422).
        if (!hostResident) throw new AppError('FORBIDDEN', 403, 'Only residents can host guests.');

        if (opts.appEnv && request.body.guest.phone) {
          assertPhoneAllowedHere({ APP_ENV: opts.appEnv }, request.body.guest.phone);
        }
        const now = clock.now();
        const windowEnd = new Date(now.getTime() + request.body.durationMinutes * 60_000);
        const visit = await createHostAssistedEntry(visitDeps, {
          principal,
          requestId: request.id,
          hostUserId: principal.userId,
          hostelId: hostResident.hostel_id,
          hostelGender: visitDeps.rulesConfig.hostel_gender,
          type: request.body.type,
          invitedName: request.body.guest.name,
          invitedPhone: request.body.guest.phone ?? null,
          invitedGender: request.body.guest.gender,
          windowStart: now,
          windowEnd,
          gateId: session.gate_id,
          photoMediaId: request.body.photoId,
          scanSessionId: session.id,
          locationVerified: session.gps_ok,
          distanceM: session.distance_m,
          accuracyM: session.accuracy_m,
        });
        await db
          .transaction()
          .execute((trx) => consumeSession(trx, clock, session.id, 'host_assisted', visit.id));
        return { status: 201, body: { visit: visitDto(visit) } };
      });
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
      const principal = request.principal;
      await runIdempotent(db, request, reply, async () => {
        const nonce = scanNonceFrom(request);
        const session = await validateAndBindSession(db, clock, request.params.id, nonce, {
          hostUserId: principal.userId,
        });
        const visitDeps = await depsForGate(session.gate_id);

        const updated = await checkOut(visitDeps, {
          principal,
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
        return { status: 200, body: { visit: visitDto(updated) } };
      });
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
      authorize(request.principal ?? null, 'gate_devices.pair', {});
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
      authorize(request.principal, 'gate_devices.heartbeat', {});
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
  // Warden pairing-code and device-revoke routes live in admin/config-routes.ts
  // (they need the X-Hostel-Id scope like every other /v1/admin route).
}
