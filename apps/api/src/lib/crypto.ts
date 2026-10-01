import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

/**
 * Generic crypto primitives (CLAUDE.md §4: gate secrets AES-256-GCM, tokens/codes
 * SHA-256 hashes, never plaintext). This module has no HAVEN-specific behaviour — it
 * is infrastructure, used first by the seed script (gate secret encryption) and later
 * by the gate/auth modules.
 */

const AES_KEY_BYTES = 32;
const GCM_IV_BYTES = 12;
const GCM_TAG_BYTES = 16;

/**
 * AES-256-GCM encrypt. Output layout matches SDD §11.3's column comment exactly:
 * `iv || tag || ciphertext`, as a single Buffer — this is what gets stored in
 * `gates.secret_enc` / `gates.prev_secret_enc`.
 */
export function encryptAesGcm(plaintext: Buffer, key: Buffer): Buffer {
  if (key.length !== AES_KEY_BYTES) {
    throw new Error(`AES-256-GCM key must be ${AES_KEY_BYTES} bytes, got ${key.length}`);
  }
  const iv = randomBytes(GCM_IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ciphertext]);
}

/** Inverse of {@link encryptAesGcm}. Throws if the tag doesn't verify (tampered/wrong key). */
export function decryptAesGcm(payload: Buffer, key: Buffer): Buffer {
  if (key.length !== AES_KEY_BYTES) {
    throw new Error(`AES-256-GCM key must be ${AES_KEY_BYTES} bytes, got ${key.length}`);
  }
  const iv = payload.subarray(0, GCM_IV_BYTES);
  const tag = payload.subarray(GCM_IV_BYTES, GCM_IV_BYTES + GCM_TAG_BYTES);
  const ciphertext = payload.subarray(GCM_IV_BYTES + GCM_TAG_BYTES);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

/** Parses the base64 `DATA_ENCRYPTION_KEY` env var into a 32-byte key (SDD §20.3). */
export function parseDataEncryptionKey(base64Key: string): Buffer {
  const key = Buffer.from(base64Key, 'base64');
  if (key.length !== AES_KEY_BYTES) {
    throw new Error(
      `DATA_ENCRYPTION_KEY must decode to exactly ${AES_KEY_BYTES} bytes, got ${key.length}`,
    );
  }
  return key;
}

/** Plain SHA-256 digest — used for token_hash/code_hash/refresh_hash columns (CLAUDE.md §4). */
export function sha256(data: Buffer | string): Buffer {
  return createHash('sha256').update(data).digest();
}

/** A fresh random secret of the given byte length (default 32, for gate secrets — SDD §9.1). */
export function randomSecret(bytes = 32): Buffer {
  return randomBytes(bytes);
}
