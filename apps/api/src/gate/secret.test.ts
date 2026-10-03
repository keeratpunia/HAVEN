import { describe, expect, it } from 'vitest';
import { randomSecret } from '../lib/crypto.js';
import {
  candidateSecrets,
  decryptGateSecret,
  encryptGateSecret,
  rotateGateSecret,
  SECRET_ROTATION_GRACE_MS,
} from './secret.js';

const KEY = randomSecret(32);

describe('gate secret lifecycle (SDD §9.1)', () => {
  it('encrypts and decrypts a gate secret round trip', () => {
    const secret = randomSecret(32);
    const encrypted = encryptGateSecret(secret, KEY);
    expect(encrypted.equals(secret)).toBe(false);
    expect(decryptGateSecret(encrypted, KEY).equals(secret)).toBe(true);
  });

  it('rotation produces a new secret and keeps the old one as prev_secret_enc', () => {
    const oldSecret = randomSecret(32);
    const now = new Date('2026-10-01T00:00:00Z');
    const row = {
      secret_enc: encryptGateSecret(oldSecret, KEY),
      secret_version: 1,
      prev_secret_enc: null,
      secret_rotated_at: null,
    };
    const rotated = rotateGateSecret(row, KEY, now);

    expect(rotated.secretVersion).toBe(2);
    expect(decryptGateSecret(rotated.prevSecretEnc, KEY).equals(oldSecret)).toBe(true);
    expect(decryptGateSecret(rotated.secretEnc, KEY).equals(oldSecret)).toBe(false);
    expect(rotated.plaintextSecret.equals(decryptGateSecret(rotated.secretEnc, KEY))).toBe(true);
  });

  it('candidateSecrets includes the previous secret only within the 120s grace window', () => {
    const current = randomSecret(32);
    const previous = randomSecret(32);
    const rotatedAt = new Date('2026-10-01T00:00:00Z');
    const row = {
      secret_enc: encryptGateSecret(current, KEY),
      secret_version: 2,
      prev_secret_enc: encryptGateSecret(previous, KEY),
      secret_rotated_at: rotatedAt,
    };

    const withinGrace = candidateSecrets(
      row,
      KEY,
      new Date(rotatedAt.getTime() + SECRET_ROTATION_GRACE_MS - 1),
    );
    expect(withinGrace).toHaveLength(2);
    expect(withinGrace.some((s) => s.equals(previous))).toBe(true);

    const afterGrace = candidateSecrets(
      row,
      KEY,
      new Date(rotatedAt.getTime() + SECRET_ROTATION_GRACE_MS + 1),
    );
    expect(afterGrace).toHaveLength(1);
    expect(afterGrace.at(0)?.equals(current)).toBe(true);
  });

  it('candidateSecrets returns only the current secret when there has never been a rotation', () => {
    const current = randomSecret(32);
    const row = {
      secret_enc: encryptGateSecret(current, KEY),
      secret_version: 1,
      prev_secret_enc: null,
      secret_rotated_at: null,
    };
    const candidates = candidateSecrets(row, KEY, new Date());
    expect(candidates).toHaveLength(1);
    expect(candidates.at(0)?.equals(current)).toBe(true);
  });
});
