import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  decryptAesGcm,
  encryptAesGcm,
  parseDataEncryptionKey,
  randomSecret,
  sha256,
} from './crypto.js';

describe('AES-256-GCM round trip', () => {
  it('encrypts and decrypts back to the original plaintext', () => {
    const key = randomBytes(32);
    const plaintext = Buffer.from('a 32-byte gate secret goes here', 'utf8');
    const encrypted = encryptAesGcm(plaintext, key);
    const decrypted = decryptAesGcm(encrypted, key);
    expect(decrypted.equals(plaintext)).toBe(true);
  });

  it('output layout is iv(12) || tag(16) || ciphertext, per SDD §11.3', () => {
    const key = randomBytes(32);
    const plaintext = randomBytes(32);
    const encrypted = encryptAesGcm(plaintext, key);
    expect(encrypted.length).toBe(12 + 16 + plaintext.length);
  });

  it('rejects a key that is not exactly 32 bytes', () => {
    expect(() => encryptAesGcm(Buffer.from('x'), randomBytes(16))).toThrow(/32 bytes/);
  });

  it('fails to decrypt with the wrong key (auth tag mismatch)', () => {
    const key1 = randomBytes(32);
    const key2 = randomBytes(32);
    const encrypted = encryptAesGcm(Buffer.from('secret'), key1);
    expect(() => decryptAesGcm(encrypted, key2)).toThrow();
  });
});

describe('parseDataEncryptionKey', () => {
  it('accepts a valid 32-byte base64 key', () => {
    const key = randomBytes(32).toString('base64');
    expect(parseDataEncryptionKey(key).length).toBe(32);
  });

  it('rejects a key of the wrong length', () => {
    const key = randomBytes(16).toString('base64');
    expect(() => parseDataEncryptionKey(key)).toThrow(/32 bytes/);
  });
});

describe('sha256', () => {
  it('is deterministic', () => {
    expect(sha256('haven').equals(sha256('haven'))).toBe(true);
  });

  it('matches the well-known SHA-256 digest of the empty string', () => {
    expect(sha256('').toString('hex')).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });
});

describe('randomSecret', () => {
  it('defaults to 32 bytes and is not predictable across calls', () => {
    const a = randomSecret();
    const b = randomSecret();
    expect(a.length).toBe(32);
    expect(a.equals(b)).toBe(false);
  });
});
