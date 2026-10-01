import { AppError } from '../lib/errors.js';

/**
 * Phone normalization (SDD §9.5: Indian mobiles only, E.164 `+91` + 10 digits starting
 * 6-9 — CLAUDE.md §2). Accepts the forms a client plausibly sends — a bare 10-digit
 * number, or one already prefixed with `+91`, `91`, or `0` — and always returns strict
 * E.164 or throws `VALIDATION_FAILED`.
 */
const E164_IN = /^\+91[6-9][0-9]{9}$/;

export function normalizePhone(raw: string): string {
  const digitsOnly = raw.replace(/[\s-]/g, '');

  let candidate: string;
  if (digitsOnly.startsWith('+91')) {
    candidate = digitsOnly;
  } else if (digitsOnly.startsWith('91') && digitsOnly.length === 12) {
    candidate = `+${digitsOnly}`;
  } else if (digitsOnly.startsWith('0') && digitsOnly.length === 11) {
    candidate = `+91${digitsOnly.slice(1)}`;
  } else {
    candidate = `+91${digitsOnly}`;
  }

  if (!E164_IN.test(candidate)) {
    throw new AppError('VALIDATION_FAILED', 400, 'Enter a valid 10-digit Indian mobile number.');
  }
  return candidate;
}
