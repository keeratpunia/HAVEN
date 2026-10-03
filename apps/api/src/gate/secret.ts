import { decryptAesGcm, encryptAesGcm, randomSecret } from '../lib/crypto.js';

/**
 * Gate secret lifecycle (SDD §9.1, §11.3): each gate has a 32-byte random secret,
 * stored encrypted (`gates.secret_enc`, AES-256-GCM with `DATA_ENCRYPTION_KEY`) with a
 * `secret_version` integer. Rotation keeps the previous secret for a 120s grace window
 * (`prev_secret_enc`/`secret_rotated_at`) so devices that haven't picked up the new
 * secret via heartbeat yet don't immediately start failing verification.
 */

export const SECRET_ROTATION_GRACE_MS = 120_000;

export interface GateSecretRow {
  secret_enc: Buffer;
  secret_version: number;
  prev_secret_enc: Buffer | null;
  secret_rotated_at: Date | null;
}

/** A fresh 32-byte gate secret, ready to encrypt and store (SDD §9.1). */
export function generateGateSecret(): Buffer {
  return randomSecret(32);
}

export function encryptGateSecret(secret: Buffer, dataEncryptionKey: Buffer): Buffer {
  return encryptAesGcm(secret, dataEncryptionKey);
}

export function decryptGateSecret(encrypted: Buffer, dataEncryptionKey: Buffer): Buffer {
  return decryptAesGcm(encrypted, dataEncryptionKey);
}

/**
 * The current secret, and (only while within the 120s rotation grace window) the
 * previous one — SDD §9.1 step 4: "Recompute the MAC with the current secret; if
 * secret_rotated_at is within the last 120s, also try the previous secret."
 */
export function candidateSecrets(
  row: GateSecretRow,
  dataEncryptionKey: Buffer,
  now: Date,
): Buffer[] {
  const candidates = [decryptGateSecret(row.secret_enc, dataEncryptionKey)];
  if (
    row.prev_secret_enc &&
    row.secret_rotated_at &&
    now.getTime() - row.secret_rotated_at.getTime() <= SECRET_ROTATION_GRACE_MS
  ) {
    candidates.push(decryptGateSecret(row.prev_secret_enc, dataEncryptionKey));
  }
  return candidates;
}

export interface RotatedSecret {
  secretEnc: Buffer;
  prevSecretEnc: Buffer;
  secretVersion: number;
  secretRotatedAt: Date;
  plaintextSecret: Buffer;
}

/**
 * Rotates a gate's secret (SDD F8 step 5: "Revoking a device invalidates its token and
 * rotates the gate secret; all other paired devices fetch the new secret on their next
 * heartbeat"). The caller persists the result and returns `plaintextSecret` to the
 * still-paired devices via the heartbeat response.
 */
export function rotateGateSecret(
  current: GateSecretRow,
  dataEncryptionKey: Buffer,
  now: Date,
): RotatedSecret {
  const newSecret = generateGateSecret();
  return {
    secretEnc: encryptGateSecret(newSecret, dataEncryptionKey),
    prevSecretEnc: current.secret_enc,
    secretVersion: current.secret_version + 1,
    secretRotatedAt: now,
    plaintextSecret: newSecret,
  };
}
