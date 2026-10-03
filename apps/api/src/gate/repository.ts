import type { Kysely, Transaction } from 'kysely';
import type { Database } from '../db/index.js';
import type { ConsumedAction, GpsFailure } from '../db/types.js';
import type { GateTokenRow } from './token.js';

/** Loads an active gate by its 6-character code (SDD §9.1 step 2). */
export async function loadActiveGateByCode(
  db: Kysely<Database>,
  gateCode: string,
): Promise<GateTokenRow | null> {
  const row = await db
    .selectFrom('haven.gates')
    .select([
      'id',
      'hostel_id',
      'code',
      'lat',
      'lng',
      'radius_m',
      'max_accuracy_m',
      'secret_enc',
      'secret_version',
      'prev_secret_enc',
      'secret_rotated_at',
      'is_active',
    ])
    .where('code', '=', gateCode)
    .executeTakeFirst();
  return row ?? null;
}

export interface ScanSessionRow {
  id: string;
  gate_id: string;
  client_nonce_hash: Buffer;
  token_step: string | number;
  token_age_steps: number;
  lat: number | null;
  lng: number | null;
  accuracy_m: number | null;
  captured_at: Date | null;
  distance_m: number | null;
  gps_ok: boolean;
  gps_failure: GpsFailure | null;
  location_attempts: number;
  visitor_id: string | null;
  host_user_id: string | null;
  photo_media_id: string | null;
  consumed_at: Date | null;
  consumed_action: ConsumedAction | null;
  expires_at: Date;
  created_at: Date;
}

export interface InsertScanSessionParams {
  gateId: string;
  clientNonceHash: Buffer;
  tokenStep: bigint;
  tokenAgeSteps: number;
  lat: number | null;
  lng: number | null;
  accuracyM: number | null;
  capturedAt: Date | null;
  distanceM: number | null;
  gpsOk: boolean;
  gpsFailure: GpsFailure | null;
  expiresAt: Date;
  ip: string | null;
  userAgent: string | null;
}

export async function insertScanSession(
  db: Kysely<Database>,
  params: InsertScanSessionParams,
): Promise<ScanSessionRow> {
  return db
    .insertInto('haven.scan_sessions')
    .values({
      gate_id: params.gateId,
      client_nonce_hash: params.clientNonceHash,
      token_step: params.tokenStep.toString(),
      token_age_steps: params.tokenAgeSteps,
      lat: params.lat,
      lng: params.lng,
      accuracy_m: params.accuracyM,
      captured_at: params.capturedAt?.toISOString() ?? null,
      distance_m: params.distanceM,
      gps_ok: params.gpsOk,
      gps_failure: params.gpsFailure,
      location_attempts: 1,
      ip: params.ip,
      user_agent: params.userAgent,
      expires_at: params.expiresAt.toISOString(),
    })
    .returningAll()
    .executeTakeFirstOrThrow() as Promise<ScanSessionRow>;
}

export async function findScanSessionById(
  db: Kysely<Database> | Transaction<Database>,
  id: string,
): Promise<ScanSessionRow | null> {
  const row = await db
    .selectFrom('haven.scan_sessions')
    .selectAll()
    .where('id', '=', id)
    .executeTakeFirst();
  return (row as ScanSessionRow | undefined) ?? null;
}

export interface RetryLocationParams {
  lat: number | null;
  lng: number | null;
  accuracyM: number | null;
  capturedAt: Date | null;
  distanceM: number | null;
  gpsOk: boolean;
  gpsFailure: GpsFailure | null;
}

/** Appends one more location attempt to an existing session (SDD §9.3 "Retry"). */
export async function recordLocationRetry(
  db: Kysely<Database>,
  id: string,
  attemptNumber: number,
  params: RetryLocationParams,
): Promise<ScanSessionRow> {
  return db
    .updateTable('haven.scan_sessions')
    .set({
      lat: params.lat,
      lng: params.lng,
      accuracy_m: params.accuracyM,
      captured_at: params.capturedAt?.toISOString() ?? null,
      distance_m: params.distanceM,
      gps_ok: params.gpsOk,
      gps_failure: params.gpsFailure,
      location_attempts: attemptNumber,
    })
    .where('id', '=', id)
    .returningAll()
    .executeTakeFirstOrThrow() as Promise<ScanSessionRow>;
}

/** Binds the first authenticated principal to a session (SDD §9.3 "Binding"). */
export async function bindSessionPrincipal(
  trx: Transaction<Database>,
  id: string,
  principal: { visitorId?: string; hostUserId?: string },
): Promise<void> {
  await trx
    .updateTable('haven.scan_sessions')
    .set({
      visitor_id: principal.visitorId ?? null,
      host_user_id: principal.hostUserId ?? null,
    })
    .where('id', '=', id)
    .execute();
}

export async function setSessionPhoto(
  db: Kysely<Database>,
  id: string,
  photoMediaId: string,
): Promise<void> {
  await db
    .updateTable('haven.scan_sessions')
    .set({ photo_media_id: photoMediaId })
    .where('id', '=', id)
    .execute();
}

/** Marks a session consumed (SDD §9.3: "A session allows one gate action; consumed_at
 * is set in the same transaction as that action"). */
export async function consumeScanSession(
  trx: Transaction<Database>,
  id: string,
  action: ConsumedAction,
  now: Date,
): Promise<void> {
  await trx
    .updateTable('haven.scan_sessions')
    .set({ consumed_at: now.toISOString(), consumed_action: action })
    .where('id', '=', id)
    .execute();
}
