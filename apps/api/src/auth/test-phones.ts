import type { Env } from '../config.js';
import { AppError } from '../lib/errors.js';
import { isTestPhone } from './otp.js';

/**
 * Phase 1's deployed test version must not take in real people (DEC-026, DEC-028). With
 * APP_ENV=staging every way a phone number enters HAVEN — OTP sign-in and phone
 * verification, the staff/resident test sign-in, a resident inviting a guest, a host
 * registering a guest at the gate — accepts only the SDD §9.5 test numbers
 * (+919999900001 … +919999900009). Local development and production are unchanged:
 * local accepts any number (the console stands in for SMS), and production never
 * accepts the test numbers' fixed code (`otp-service.ts`).
 */

export const TEST_PHONES_ONLY_MESSAGE =
  'This is a test version. Please use one of the test numbers.';

export function assertPhoneAllowedHere(env: Pick<Env, 'APP_ENV'>, phone: string): void {
  if (env.APP_ENV === 'staging' && !isTestPhone(phone)) {
    throw new AppError('TEST_PHONES_ONLY', 403, TEST_PHONES_ONLY_MESSAGE);
  }
}
