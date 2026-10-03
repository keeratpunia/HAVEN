import { createHmac, timingSafeEqual } from 'node:crypto';
import { AppError } from '../lib/errors.js';
import { candidateSecrets, type GateSecretRow } from './secret.js';

/**
 * Rotating gate QR token (SDD §9.1). Generated on the gate device every 10s from the
 * gate's secret; verified here against the gate's current (and, within a 120s grace
 * window, previous) secret. Not single-use — several guests may scan the same code;
 * replay is bounded by the 30s token age plus the geofence check (SDD §9.3).
 */

export const STEP_MS = 10_000;

// Matches lib/ids.ts's CROCKFORD_ALPHABET exactly (duplicated, not imported — that
// file's constant is private generation-only; this module needs the same alphabet for
// a byte-level base32 *encoder*, a distinct operation from random-char generation).
const CROCKFORD_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

const TOKEN_PATTERN = /^([A-Z0-9]{6})\.(\d{1,12})\.([0-9A-HJKMNP-TV-Z]{16})$/;

/** Base32 Crockford-encodes a buffer, 5 bits per output character, no padding. */
function base32CrockfordEncode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += CROCKFORD_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += CROCKFORD_ALPHABET[(value << (5 - bits)) & 31];
  }
  return output;
}

function macFor(secret: Buffer, gateCode: string, step: bigint): Buffer {
  const msg = `HVG1|${gateCode}|${step.toString()}`;
  return createHmac('sha256', secret).update(msg).digest().subarray(0, 10);
}

/**
 * Generates the current rotating token for a gate (SDD §9.1's client-side algorithm,
 * reproduced here so tests and the seed/e2e fixtures can produce a token exactly as
 * a real gate device would — the actual `/gate` display page runs the same algorithm
 * client-side in the browser, not via this function).
 */
export function generateGateToken(params: {
  secret: Buffer;
  gateCode: string;
  now: Date;
  offsetMs?: number;
}): string {
  const step = BigInt(Math.floor((params.now.getTime() + (params.offsetMs ?? 0)) / STEP_MS));
  const mac = macFor(params.secret, params.gateCode, step);
  return `${params.gateCode}.${step.toString()}.${base32CrockfordEncode(mac)}`;
}

export interface GateTokenRow extends GateSecretRow {
  id: string;
  hostel_id: string;
  is_active: boolean;
}

export interface VerifiedGateToken {
  gate: GateTokenRow;
  tokenStep: bigint;
  tokenAgeSteps: number;
}

/**
 * Verifies a scanned gate token (SDD §9.1 steps 1-4). `loadActiveGate` is injected so
 * callers control the DB query (and tests can fake it) without this module owning a
 * Kysely dependency directly.
 */
export async function verifyGateToken(
  token: string,
  dataEncryptionKey: Buffer,
  now: Date,
  loadActiveGate: (gateCode: string) => Promise<GateTokenRow | null>,
): Promise<VerifiedGateToken> {
  const match = TOKEN_PATTERN.exec(token);
  if (!match) {
    throw new AppError('GATE_TOKEN_INVALID', 400, "We can't read this code.");
  }
  const [, gateCode, stepStr, macPart] = match as unknown as [string, string, string, string];

  const gate = await loadActiveGate(gateCode);
  if (!gate || !gate.is_active) {
    throw new AppError('GATE_TOKEN_INVALID', 400, "We can't read this code.");
  }

  const tokenStep = BigInt(stepStr);
  const serverStep = BigInt(Math.floor(now.getTime() / STEP_MS));
  const ageSteps = serverStep - tokenStep;
  // SDD §9.1 step 3: "Accept if -1 <= age <= 2 (up to 30s old, or one step ahead for a
  // fast device clock). Otherwise GATE_TOKEN_EXPIRED." Covers both a stale/old token
  // and one from so far in the future it can't be a clock-skew artifact.
  if (ageSteps < -1n || ageSteps > 2n) {
    throw new AppError('GATE_TOKEN_EXPIRED', 410, 'That code has changed.');
  }

  const candidates = candidateSecrets(gate, dataEncryptionKey, now);
  const providedMac = Buffer.from(decodeCrockfordMac(macPart));
  const matches = candidates.some((secret) => {
    const expectedMac = macFor(secret, gateCode, tokenStep);
    return expectedMac.length === providedMac.length && timingSafeEqual(expectedMac, providedMac);
  });
  if (!matches) {
    throw new AppError('GATE_TOKEN_INVALID', 400, "We can't read this code.");
  }

  return { gate, tokenStep, tokenAgeSteps: Number(ageSteps) };
}

const CROCKFORD_DECODE: Record<string, number> = Object.fromEntries(
  [...CROCKFORD_ALPHABET].map((char, index) => [char, index]),
);

/** Inverse of {@link base32CrockfordEncode}, for the fixed 16-char (80-bit) MAC field. */
function decodeCrockfordMac(encoded: string): Uint8Array {
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of encoded) {
    const charValue = CROCKFORD_DECODE[char];
    if (charValue === undefined) {
      throw new AppError('GATE_TOKEN_INVALID', 400, "We can't read this code.");
    }
    value = (value << 5) | charValue;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Uint8Array.from(out);
}
