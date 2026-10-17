import type { Kysely, Transaction } from 'kysely';
import type { Database } from '../db/index.js';
import type { ConsumedAction } from '../db/types.js';
import { AppError } from '../lib/errors.js';
import { sha256 } from '../lib/crypto.js';
import type { Clock } from '../lib/clock.js';
import { evaluateGeofence, type GateLocationInput } from './geofence.js';
import { verifyGateToken } from './token.js';
import {
  consumeScanSession,
  findScanSessionById,
  findScanSessionByVisitAndAction,
  insertScanSession,
  loadActiveGateByCode,
  recordLocationRetry,
  setSessionPhoto,
  type ScanSessionRow,
} from './repository.js';

/**
 * Scan sessions (SDD §9.3): "proves this browser saw a fresh gate QR at the gate",
 * letting slow steps (OTP, profile, selfie) happen after the 30s token window without
 * re-scanning.
 */

const SCAN_SESSION_TTL_MS = 10 * 60_000;
const MAX_LOCATION_ATTEMPTS = 3;

export interface CreateScanSessionParams {
  token: string;
  clientNonce: string;
  location: GateLocationInput | null;
  mocked?: boolean;
  ip: string | null;
  userAgent: string | null;
}

export interface ScanSessionResponse {
  scanSessionId: string;
  gpsOk: boolean;
  gpsFailure: string | null;
  distanceM: number | null;
  hostel: { id: string; name: string };
  gate: { id: string; name: string };
  expiresAt: string;
}

export interface GateDeps {
  db: Kysely<Database>;
  clock: Clock;
  dataEncryptionKey: Buffer;
}

async function loadGateHostel(
  db: Kysely<Database>,
  gateId: string,
): Promise<{ id: string; name: string } | null> {
  const row = await db
    .selectFrom('haven.hostels')
    .innerJoin('haven.gates', 'haven.gates.hostel_id', 'haven.hostels.id')
    .select(['haven.hostels.id', 'haven.hostels.name'])
    .where('haven.gates.id', '=', gateId)
    .executeTakeFirst();
  return row ?? null;
}

/** SDD §9.3 server algorithm, steps 1-5. Public endpoint — auth optional. */
export async function createScanSession(
  deps: GateDeps,
  params: CreateScanSessionParams,
): Promise<ScanSessionResponse> {
  // CLAUDE.md §4: "the server mirrors [mock-location detection] with MOCK_LOCATION (403)."
  if (params.mocked === true) {
    throw new AppError('MOCK_LOCATION', 403, 'Turn off fake location apps.');
  }

  const now = deps.clock.now();
  const verified = await verifyGateToken(params.token, deps.dataEncryptionKey, now, (code) =>
    loadActiveGateByCode(deps.db, code),
  );

  const hostel = await loadGateHostel(deps.db, verified.gate.id);
  if (!hostel) {
    throw new AppError('GATE_NOT_CONFIGURED', 503, 'This hostel has no gate set up yet.');
  }

  const gateRow = await deps.db
    .selectFrom('haven.gates')
    .select(['id', 'name', 'lat', 'lng', 'radius_m', 'max_accuracy_m'])
    .where('id', '=', verified.gate.id)
    .executeTakeFirstOrThrow();

  const geofence = params.location
    ? evaluateGeofence(
        {
          lat: gateRow.lat,
          lng: gateRow.lng,
          radiusM: gateRow.radius_m,
          maxAccuracyM: gateRow.max_accuracy_m,
        },
        params.location,
      )
    : { gpsOk: false, gpsFailure: 'no_location' as const, distanceM: null };

  const expiresAt = new Date(now.getTime() + SCAN_SESSION_TTL_MS);
  const session = await insertScanSession(deps.db, {
    gateId: verified.gate.id,
    clientNonceHash: sha256(params.clientNonce),
    tokenStep: verified.tokenStep,
    tokenAgeSteps: verified.tokenAgeSteps,
    lat: params.location?.lat ?? null,
    lng: params.location?.lng ?? null,
    accuracyM: params.location?.accuracy ?? null,
    capturedAt: params.location ? now : null,
    distanceM: geofence.distanceM,
    gpsOk: geofence.gpsOk,
    gpsFailure: geofence.gpsFailure,
    createdAt: now,
    expiresAt,
    ip: params.ip,
    userAgent: params.userAgent,
  });

  return {
    scanSessionId: session.id,
    gpsOk: session.gps_ok,
    gpsFailure: session.gps_failure,
    distanceM: session.distance_m,
    hostel,
    gate: { id: gateRow.id, name: gateRow.name },
    expiresAt: session.expires_at.toISOString(),
  };
}

/** SDD §9.3 "Retry": `POST /scan-sessions/{id}/location`, allowed while attempts < 3. */
export async function retryScanSessionLocation(
  deps: GateDeps,
  sessionId: string,
  location: GateLocationInput | null,
  mocked?: boolean,
): Promise<ScanSessionResponse> {
  if (mocked === true) {
    throw new AppError('MOCK_LOCATION', 403, 'Turn off fake location apps.');
  }

  const session = await findScanSessionById(deps.db, sessionId);
  if (!session) {
    throw new AppError('SCAN_SESSION_EXPIRED', 410, 'This session has expired.');
  }
  const now = deps.clock.now();
  if (session.expires_at.getTime() <= now.getTime() || session.consumed_at) {
    throw new AppError('SCAN_SESSION_EXPIRED', 410, 'This session has expired.');
  }
  if (session.location_attempts >= MAX_LOCATION_ATTEMPTS) {
    throw new AppError('LOCATION_RETRY_LIMIT', 429, 'Ask the host to confirm you are at the gate.');
  }

  const gateRow = await deps.db
    .selectFrom('haven.gates')
    .select(['id', 'name', 'hostel_id', 'lat', 'lng', 'radius_m', 'max_accuracy_m'])
    .where('id', '=', session.gate_id)
    .executeTakeFirstOrThrow();
  const hostelRow = await deps.db
    .selectFrom('haven.hostels')
    .select(['id', 'name'])
    .where('id', '=', gateRow.hostel_id)
    .executeTakeFirstOrThrow();

  const geofence = location
    ? evaluateGeofence(
        {
          lat: gateRow.lat,
          lng: gateRow.lng,
          radiusM: gateRow.radius_m,
          maxAccuracyM: gateRow.max_accuracy_m,
        },
        location,
      )
    : { gpsOk: false, gpsFailure: 'no_location' as const, distanceM: null };

  const updated = await recordLocationRetry(deps.db, sessionId, session.location_attempts + 1, {
    lat: location?.lat ?? null,
    lng: location?.lng ?? null,
    accuracyM: location?.accuracy ?? null,
    capturedAt: location ? now : null,
    distanceM: geofence.distanceM,
    gpsOk: geofence.gpsOk,
    gpsFailure: geofence.gpsFailure,
  });

  return {
    scanSessionId: updated.id,
    gpsOk: updated.gps_ok,
    gpsFailure: updated.gps_failure,
    distanceM: updated.distance_m,
    hostel: hostelRow,
    gate: { id: gateRow.id, name: gateRow.name },
    expiresAt: updated.expires_at.toISOString(),
  };
}

/**
 * Validates and binds a session for every `/scan-sessions/{id}/*` call after creation
 * (SDD §9.3 "Binding"): unexpired, unconsumed, `X-Scan-Nonce` matches, and the first
 * authenticated call sets the principal; after that, only that principal may use it.
 * Binding itself is a one-directional ratchet (null -> set) applied directly, outside
 * whatever transaction the caller's subsequent action opens — it never needs to roll
 * back with that action.
 */
export async function validateAndBindSession(
  db: Kysely<Database>,
  clock: Clock,
  sessionId: string,
  clientNonce: string,
  principal: { visitorId?: string; hostUserId?: string } | null,
): Promise<ScanSessionRow> {
  const session = await findScanSessionById(db, sessionId);
  if (!session) {
    throw new AppError('SCAN_SESSION_EXPIRED', 410, 'This session has expired.');
  }
  const now = clock.now();
  if (session.expires_at.getTime() <= now.getTime() || session.consumed_at) {
    throw new AppError('SCAN_SESSION_EXPIRED', 410, 'This session has expired.');
  }

  const providedHash = sha256(clientNonce);
  if (!providedHash.equals(session.client_nonce_hash)) {
    throw new AppError('SCAN_SESSION_FORBIDDEN', 403, "This session doesn't belong to you.");
  }

  const boundVisitor = session.visitor_id;
  const boundHost = session.host_user_id;

  if (boundVisitor === null && boundHost === null) {
    if (principal?.visitorId || principal?.hostUserId) {
      await db
        .updateTable('haven.scan_sessions')
        .set({
          visitor_id: principal.visitorId ?? null,
          host_user_id: principal.hostUserId ?? null,
        })
        .where('id', '=', sessionId)
        .execute();
      return {
        ...session,
        visitor_id: principal.visitorId ?? null,
        host_user_id: principal.hostUserId ?? null,
      };
    }
    return session;
  }

  if (principal?.visitorId && boundVisitor !== principal.visitorId) {
    throw new AppError(
      'SCAN_SESSION_FORBIDDEN',
      403,
      'A different person already used this session.',
    );
  }
  if (principal?.hostUserId && boundHost !== principal.hostUserId) {
    throw new AppError(
      'SCAN_SESSION_FORBIDDEN',
      403,
      'A different person already used this session.',
    );
  }
  return session;
}

export async function consumeSession(
  trx: Transaction<Database>,
  clock: Clock,
  sessionId: string,
  action: ConsumedAction,
  visitId: string,
): Promise<void> {
  await consumeScanSession(trx, sessionId, action, clock.now(), visitId);
}

/**
 * The scan session a walk-in was created from, so the host's later approval can reuse
 * its GPS facts rather than requiring a second scan (SDD F2 step 9). `undefined` if
 * none is found — a caller must still work (e.g. a visit created by some other path).
 */
export async function findWalkInSessionForVisit(
  db: Kysely<Database>,
  visitId: string,
): Promise<ScanSessionRow | null> {
  return findScanSessionByVisitAndAction(db, visitId, 'walk_in');
}

export { setSessionPhoto, MAX_LOCATION_ATTEMPTS };
