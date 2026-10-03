import type { Kysely } from 'kysely';
import type { Database } from '../db/index.js';
import { AppError } from '../lib/errors.js';
import { randomSecret, sha256 } from '../lib/crypto.js';
import { generatePairingCode, formatPairingCodeForDisplay } from '../lib/ids.js';
import type { Clock } from '../lib/clock.js';
import { decryptGateSecret, rotateGateSecret } from './secret.js';

/**
 * Gate device pairing, heartbeat and revocation (SDD F8, §9.1 secret rotation, §12.8/
 * §12.9 endpoints).
 */

const PAIRING_CODE_TTL_MS = 10 * 60_000;
const DEVICE_TOKEN_PREFIX = 'gd_';

function generateDeviceToken(): string {
  // 32 random bytes, base64url (SDD §9.7's token table: "gd_ + 32 random bytes base64url").
  return DEVICE_TOKEN_PREFIX + randomSecret(32).toString('base64url');
}

export interface VerifiedDevice {
  deviceId: string;
  gateId: string;
}

/**
 * Verifies an `Authorization: Device <token>` header (SDD §9.1/§12.8) against
 * `haven.gate_devices.token_hash`. Closes the gap `authenticate.ts`'s module comment
 * names as deferred to "the gate module".
 *
 * Deliberately resolves a *revoked* device's token too, rather than treating it like
 * an unknown one: SDD §9.2/F8 says a revoked device's own heartbeat response (not a
 * 401) is how it learns to wipe its storage and show D-03 ("This device was removed by
 * the warden") — `recordHeartbeat` is what actually enforces the revocation by
 * returning `{ revoked: true }` instead of acting on the request. No other gate action
 * accepts a device principal today, so this only ever reaches that one, safe path.
 */
export async function verifyDeviceToken(
  db: Kysely<Database>,
  token: string,
): Promise<VerifiedDevice | null> {
  const row = await db
    .selectFrom('haven.gate_devices')
    .select(['id', 'gate_id'])
    .where('token_hash', '=', sha256(token))
    .executeTakeFirst();
  if (!row) return null;
  return { deviceId: row.id, gateId: row.gate_id };
}

export interface CreatePairingCodeParams {
  db: Kysely<Database>;
  clock: Clock;
  gateId: string;
  createdByUserId: string;
}

export interface PairingCodeResult {
  code: string;
  displayCode: string;
  expiresAt: Date;
}

/** SDD F8 step 1: warden adds a device, server returns an 8-char code valid 10 min. */
export async function createPairingCode(
  params: CreatePairingCodeParams,
): Promise<PairingCodeResult> {
  const code = generatePairingCode();
  const expiresAt = new Date(params.clock.now().getTime() + PAIRING_CODE_TTL_MS);
  await params.db
    .insertInto('haven.gate_pairing_codes')
    .values({
      code_hash: sha256(code),
      gate_id: params.gateId,
      created_by: params.createdByUserId,
      expires_at: expiresAt.toISOString(),
    })
    .execute();
  return { code, displayCode: formatPairingCodeForDisplay(code), expiresAt };
}

export interface PairDeviceParams {
  db: Kysely<Database>;
  clock: Clock;
  dataEncryptionKey: Buffer;
  code: string;
  label?: string;
  ip: string | null;
  userAgent: string | null;
}

export interface PairDeviceResult {
  deviceToken: string;
  gate: { code: string; name: string };
  hostelName: string;
  secret: string; // base64 — handed to the device once, at pairing
  secretVersion: number;
  serverTime: string;
}

/** SDD F8 step 2-3: `POST /gate-devices/pair`. Public (the code itself is the secret). */
export async function pairDevice(params: PairDeviceParams): Promise<PairDeviceResult> {
  const now = params.clock.now();
  const codeHash = sha256(params.code);

  const pairingCode = await params.db
    .selectFrom('haven.gate_pairing_codes')
    .selectAll()
    .where('code_hash', '=', codeHash)
    .executeTakeFirst();
  if (!pairingCode || pairingCode.used_at || pairingCode.expires_at.getTime() <= now.getTime()) {
    throw new AppError('NOT_FOUND', 404, 'This pairing code is invalid or has expired.');
  }

  const gate = await params.db
    .selectFrom('haven.gates')
    .innerJoin('haven.hostels', 'haven.hostels.id', 'haven.gates.hostel_id')
    .select([
      'haven.gates.id',
      'haven.gates.code',
      'haven.gates.name',
      'haven.gates.secret_enc',
      'haven.gates.secret_version',
      'haven.hostels.name as hostel_name',
    ])
    .where('haven.gates.id', '=', pairingCode.gate_id)
    .executeTakeFirstOrThrow();

  const deviceToken = generateDeviceToken();
  const device = await params.db
    .insertInto('haven.gate_devices')
    .values({
      gate_id: gate.id,
      label: params.label ?? 'Gate phone',
      token_hash: sha256(deviceToken),
      paired_by: pairingCode.created_by,
      last_ip: params.ip,
      user_agent: params.userAgent,
    })
    .returning('id')
    .executeTakeFirstOrThrow();

  await params.db
    .updateTable('haven.gate_pairing_codes')
    .set({ used_at: now.toISOString(), device_id: device.id })
    .where('code_hash', '=', codeHash)
    .execute();

  const secret = decryptGateSecret(gate.secret_enc, params.dataEncryptionKey);

  return {
    deviceToken,
    gate: { code: gate.code, name: gate.name },
    hostelName: gate.hostel_name,
    secret: secret.toString('base64'),
    secretVersion: gate.secret_version,
    serverTime: now.toISOString(),
  };
}

export interface HeartbeatParams {
  db: Kysely<Database>;
  clock: Clock;
  dataEncryptionKey: Buffer;
  deviceId: string;
  clientTime: string;
  ip: string | null;
  userAgent: string | null;
}

export interface HeartbeatResult {
  serverTime: string;
  secretVersion: number;
  secret?: string;
  revoked: boolean;
}

/** SDD §9.2/F8 step 5: `POST /gate-devices/heartbeat`, every 60s. */
export async function recordHeartbeat(params: HeartbeatParams): Promise<HeartbeatResult> {
  const now = params.clock.now();
  const device = await params.db
    .selectFrom('haven.gate_devices')
    .selectAll()
    .where('id', '=', params.deviceId)
    .executeTakeFirst();
  if (!device) {
    throw new AppError('NOT_FOUND', 404, 'Device not found.');
  }

  if (device.revoked_at) {
    return { serverTime: now.toISOString(), secretVersion: 0, revoked: true };
  }

  const clientTimeMs = Date.parse(params.clientTime);
  const clockOffsetMs = Number.isNaN(clientTimeMs) ? null : now.getTime() - clientTimeMs;

  await params.db
    .updateTable('haven.gate_devices')
    .set({
      last_seen_at: now.toISOString(),
      last_ip: params.ip,
      user_agent: params.userAgent,
      clock_offset_ms: clockOffsetMs,
      offline_alerted_at: null,
    })
    .where('id', '=', params.deviceId)
    .execute();

  const gate = await params.db
    .selectFrom('haven.gates')
    .select(['secret_enc', 'secret_version', 'prev_secret_enc', 'secret_rotated_at'])
    .where('id', '=', device.gate_id)
    .executeTakeFirstOrThrow();

  // `gate_devices` has no "last-known secret version" column to diff against, so this
  // always includes `secret` rather than tracking per-device staleness — harmless
  // (the device just re-stores the same value when nothing rotated) and is how a
  // non-revoked device picks up a rotation triggered by revoking a *different* device
  // paired to the same gate (SDD F8 step 5).
  return {
    serverTime: now.toISOString(),
    secretVersion: gate.secret_version,
    secret: decryptGateSecret(gate.secret_enc, params.dataEncryptionKey).toString('base64'),
    revoked: false,
  };
}

export interface RevokeDeviceParams {
  db: Kysely<Database>;
  clock: Clock;
  dataEncryptionKey: Buffer;
  deviceId: string;
  revokedByUserId: string;
}

/** SDD F8 step 5: revoking a device rotates the gate's secret for every device. */
export async function revokeDevice(params: RevokeDeviceParams): Promise<void> {
  const now = params.clock.now();
  const device = await params.db
    .selectFrom('haven.gate_devices')
    .selectAll()
    .where('id', '=', params.deviceId)
    .executeTakeFirst();
  if (!device) {
    throw new AppError('NOT_FOUND', 404, 'Device not found.');
  }

  await params.db
    .updateTable('haven.gate_devices')
    .set({ revoked_at: now.toISOString(), revoked_by: params.revokedByUserId })
    .where('id', '=', params.deviceId)
    .execute();

  const gate = await params.db
    .selectFrom('haven.gates')
    .select(['secret_enc', 'secret_version', 'prev_secret_enc', 'secret_rotated_at'])
    .where('id', '=', device.gate_id)
    .executeTakeFirstOrThrow();

  const rotated = rotateGateSecret(gate, params.dataEncryptionKey, now);
  await params.db
    .updateTable('haven.gates')
    .set({
      secret_enc: rotated.secretEnc,
      prev_secret_enc: rotated.prevSecretEnc,
      secret_version: rotated.secretVersion,
      secret_rotated_at: rotated.secretRotatedAt.toISOString(),
    })
    .where('id', '=', device.gate_id)
    .execute();
}
