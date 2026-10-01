import { randomInt } from 'node:crypto';
import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * OTP code generation and hashing (SDD §9.5): 6 digits via `crypto.randomInt`, stored
 * as `HMAC_SHA256(OTP_PEPPER, phone + '|' + code)` — never the plaintext code.
 *
 * Non-production test phones `+919999900001`-`+919999900009` always accept code
 * `123456` (SDD §9.5, "non-production only") — `isTestPhone`/`TEST_OTP_CODE` exist so
 * the verify flow can special-case them without ever generating/storing/logging a real
 * challenge for them.
 */

export const TEST_OTP_CODE = '123456';
const TEST_PHONE_PATTERN = /^\+91999990000[1-9]$/;

export function isTestPhone(phone: string): boolean {
  return TEST_PHONE_PATTERN.test(phone);
}

export function generateOtpCode(): string {
  return randomInt(0, 1_000_000).toString().padStart(6, '0');
}

export function hashOtpCode(otpPepperBase64: string, phone: string, code: string): Buffer {
  const key = Buffer.from(otpPepperBase64, 'base64');
  return createHmac('sha256', key).update(`${phone}|${code}`).digest();
}

export function otpCodeMatches(
  otpPepperBase64: string,
  phone: string,
  code: string,
  storedHash: Buffer,
): boolean {
  const candidate = hashOtpCode(otpPepperBase64, phone, code);
  if (candidate.length !== storedHash.length) return false;
  return timingSafeEqual(candidate, storedHash);
}
