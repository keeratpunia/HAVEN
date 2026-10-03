/**
 * Client-side rotating gate QR token generation (SDD §9.1), run entirely in the gate
 * display page's browser — works offline, as the SDD requires ("QR still valid
 * (generated locally)" — E-01). Mirrors `apps/api/src/gate/token.ts`'s algorithm
 * exactly; duplicated rather than shared because the server module uses `node:crypto`
 * and this one must run in a browser with Web Crypto (`crypto.subtle`), no Node APIs.
 */

export const STEP_MS = 10_000;

const CROCKFORD_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function base32CrockfordEncode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of bytes) {
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

async function hmacSha256(secret: Uint8Array, message: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw',
    secret.slice().buffer,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return new Uint8Array(signature);
}

export function decodeBase64Secret(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function currentStep(offsetMs: number): bigint {
  return BigInt(Math.floor((Date.now() + offsetMs) / STEP_MS));
}

/** `token = gateCode + "." + step + "." + base32crockford(mac)` (SDD §9.1). */
export async function generateGateToken(params: {
  secret: Uint8Array;
  gateCode: string;
  step: bigint;
}): Promise<string> {
  const msg = `HVG1|${params.gateCode}|${params.step.toString()}`;
  const mac = await hmacSha256(params.secret, msg);
  const macBytes = mac.subarray(0, 10);
  return `${params.gateCode}.${params.step.toString()}.${base32CrockfordEncode(macBytes)}`;
}
