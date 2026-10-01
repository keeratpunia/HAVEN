import { randomInt } from 'node:crypto';

/**
 * Human-facing ID formats (SDD §9.11). Primary keys themselves are `gen_random_uuid()`
 * at the database level (SDD §11) — these generators are only for the derived,
 * human-readable codes layered on top.
 */

// Crockford base32: excludes I, L, O, U to avoid visual confusion (0/O, 1/I/L).
const CROCKFORD_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function randomCrockfordChars(length: number): string {
  let out = '';
  for (let i = 0; i < length; i++) {
    out += CROCKFORD_ALPHABET.charAt(randomInt(CROCKFORD_ALPHABET.length));
  }
  return out;
}

/** Visit code: `V` + 6 Crockford chars, e.g. `V7K3Q9A` — matches `^V[0-9A-HJKMNP-TV-Z]{6}$`. */
export function generateVisitCode(): string {
  return `V${randomCrockfordChars(6)}`;
}

/** Pairing code: 8 Crockford chars. Returned unformatted; display as `XXXX-XXXX` (SDD §9.11). */
export function generatePairingCode(): string {
  return randomCrockfordChars(8);
}

export function formatPairingCodeForDisplay(code: string): string {
  if (code.length !== 8) {
    throw new Error(`Pairing code must be 8 characters, got ${code.length}`);
  }
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

const UPPER_ALPHANUMERIC = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

/** Gate code: 6 uppercase alphanumerics, e.g. `GH8A01` — matches `^[A-Z0-9]{6}$`. */
export function generateGateCode(): string {
  let out = '';
  for (let i = 0; i < 6; i++) {
    out += UPPER_ALPHANUMERIC.charAt(randomInt(UPPER_ALPHANUMERIC.length));
  }
  return out;
}
