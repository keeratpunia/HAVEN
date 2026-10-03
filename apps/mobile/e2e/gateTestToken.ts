import { createHmac } from 'node:crypto';

/**
 * Node-side rotating gate QR token generator for the Playwright suite — mirrors
 * `apps/api/src/gate/token.ts` and `apps/mobile/lib/gateToken.ts`'s algorithm exactly
 * (SDD §9.1). Duplicated rather than imported: this file runs under Playwright's own
 * Node test runner, a different package/module-resolution context than either of
 * those two (one server-side, one browser-side), so it gets its own small copy rather
 * than reaching across package boundaries.
 *
 * The E2E API server's clock is frozen at `E2E_FIXED_NOW`
 * (apps/api/scripts/e2e-constants.ts) — every token here must be generated against
 * that same fixed instant, not the real wall clock the test happens to run at.
 */

export const STEP_MS = 10_000;
export const E2E_FIXED_NOW = new Date('2026-10-01T06:30:00.000Z');
export const E2E_GATE_CODE = 'GH8A01';
/** Must match `E2E_GATE_SECRET` in apps/api/scripts/e2e-constants.ts exactly. */
export const E2E_GATE_SECRET = Buffer.alloc(32, 3);

const CROCKFORD_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

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

export function generateTestGateToken(params: {
  secret?: Buffer;
  gateCode?: string;
  now?: Date;
  stepOffset?: number;
}): string {
  const secret = params.secret ?? E2E_GATE_SECRET;
  const gateCode = params.gateCode ?? E2E_GATE_CODE;
  const now = params.now ?? E2E_FIXED_NOW;
  const step = BigInt(Math.floor(now.getTime() / STEP_MS)) + BigInt(params.stepOffset ?? 0);
  const msg = `HVG1|${gateCode}|${step.toString()}`;
  const mac = createHmac('sha256', secret).update(msg).digest().subarray(0, 10);
  return `${gateCode}.${step.toString()}.${base32CrockfordEncode(mac)}`;
}
