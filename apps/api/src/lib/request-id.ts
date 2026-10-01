import { randomBytes } from 'node:crypto';

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

/**
 * Request ID format per SDD §9.11: `req_` + 12 chars. Used as Fastify's `genReqId` so
 * every request/response/log line/error envelope carries the same id (SDD §12.1,
 * §18.1, NFR-13).
 */
export function generateRequestId(): string {
  const bytes = randomBytes(12);
  let suffix = '';
  for (let i = 0; i < 12; i++) {
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- i < bytes.length by construction (Buffer.length === 12), index is always in range
    const byte = bytes[i]!;
    // .charAt() never returns undefined (empty string at worst), so no assertion needed here
    suffix += ALPHABET.charAt(byte % ALPHABET.length);
  }
  return `req_${suffix}`;
}
