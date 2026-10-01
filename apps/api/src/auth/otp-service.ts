import type { Kysely } from 'kysely';
import type { Database } from '../db/index.js';
import type { OtpPurpose } from '../db/types.js';
import type { Clock } from '../lib/clock.js';
import { AppError } from '../lib/errors.js';
import type { Env } from '../config.js';
import { generateOtpCode, hashOtpCode, isTestPhone, otpCodeMatches, TEST_OTP_CODE } from './otp.js';

/**
 * Guest phone OTP (SDD §9.5): 6-digit code, `HMAC_SHA256(OTP_PEPPER, phone + '|' +
 * code)` storage, 5-minute TTL, 30s resend cooldown, 3 requests/phone/10min + 10/IP/hour,
 * 5 wrong attempts burns the code, non-production test phones bypass entirely.
 */

const OTP_TTL_MS = 5 * 60 * 1000;
const RESEND_COOLDOWN_MS = 30 * 1000;
const MAX_REQUESTS_PER_PHONE_10MIN = 3;
const PHONE_WINDOW_MS = 10 * 60 * 1000;
const MAX_REQUESTS_PER_IP_HOUR = 10;
const IP_WINDOW_MS = 60 * 60 * 1000;
const MAX_ATTEMPTS = 5;

export interface RequestOtpResult {
  resendAfterS: number;
}

/**
 * Sends an OTP code via the configured provider. `console` is a local/dev convenience
 * (SDD §9.5) — it deliberately does NOT go through the structured Pino logger (which
 * exists precisely to keep PII/secrets out of persisted logs); it's a direct stdout
 * write, gated to non-production, and nothing else in the app reads or ships it
 * anywhere. `msg91` (real SMS) is not implemented — there are no real MSG91
 * credentials available in this environment, and CLAUDE.md §4 forbids hardcoding fake
 * production secrets, so this throws clearly rather than pretending to send anything.
 */
function sendOtpViaProvider(
  env: Pick<Env, 'SMS_PROVIDER' | 'APP_ENV'>,
  phone: string,
  code: string,
): void {
  if (env.SMS_PROVIDER === 'console') {
    if (env.APP_ENV === 'production') {
      throw new Error('SMS_PROVIDER=console must never be used in production');
    }
    // eslint-disable-next-line no-console -- intentional dev-only OTP delivery, see doc comment above
    console.log(`[otp:dev] ${phone} purpose-code=${code}`);
    return;
  }
  throw new Error(
    'SMS_PROVIDER=msg91 is not implemented: no real MSG91 credentials are available in this ' +
      'environment. Implement Msg91SmsSender (injected like RealGoogleIdTokenVerifier) when ' +
      'real credentials exist — do not hardcode a fake key.',
  );
}

export async function requestOtp(
  db: Kysely<Database>,
  params: { phone: string; purpose: OtpPurpose; ip: string | null },
  env: Pick<Env, 'SMS_PROVIDER' | 'APP_ENV' | 'OTP_PEPPER'>,
  clock: Clock,
): Promise<RequestOtpResult> {
  const now = clock.now();

  const recentForPhone = await db
    .selectFrom('haven.otp_challenges')
    .select((eb) => eb.fn.countAll<string>().as('n'))
    .where('phone', '=', params.phone)
    .where('created_at', '>=', new Date(now.getTime() - PHONE_WINDOW_MS))
    .executeTakeFirstOrThrow();
  if (Number(recentForPhone.n) >= MAX_REQUESTS_PER_PHONE_10MIN) {
    throw new AppError(
      'RATE_LIMITED',
      429,
      'Too many OTP requests for this number. Try again later.',
    );
  }

  if (params.ip) {
    const recentForIp = await db
      .selectFrom('haven.otp_challenges')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .where('ip', '=', params.ip)
      .where('created_at', '>=', new Date(now.getTime() - IP_WINDOW_MS))
      .executeTakeFirstOrThrow();
    if (Number(recentForIp.n) >= MAX_REQUESTS_PER_IP_HOUR) {
      throw new AppError('RATE_LIMITED', 429, 'Too many OTP requests. Try again later.');
    }
  }

  const latest = await db
    .selectFrom('haven.otp_challenges')
    .select(['created_at'])
    .where('phone', '=', params.phone)
    .where('purpose', '=', params.purpose)
    .orderBy('created_at', 'desc')
    .executeTakeFirst();
  if (latest && now.getTime() - latest.created_at.getTime() < RESEND_COOLDOWN_MS) {
    throw new AppError('RATE_LIMITED', 429, 'Please wait before requesting another code.', {
      retryAfterS: Math.ceil(
        (RESEND_COOLDOWN_MS - (now.getTime() - latest.created_at.getTime())) / 1000,
      ),
    });
  }

  const code = generateOtpCode();
  const codeHash = hashOtpCode(env.OTP_PEPPER, params.phone, code);

  await db
    .insertInto('haven.otp_challenges')
    .values({
      phone: params.phone,
      purpose: params.purpose,
      code_hash: codeHash,
      // `created_at` defaults to the DB server's own `now()`, which is NOT the
      // injected Clock — every rate-limit/cooldown comparison below reads this column
      // against `clock.now()`, so it must be set explicitly from the same clock the
      // rest of this function uses, or the two clocks silently diverge under tests
      // (and, in principle, under real server/DB clock skew).
      created_at: now,
      expires_at: new Date(now.getTime() + OTP_TTL_MS).toISOString(),
      ip: params.ip,
    })
    .execute();

  sendOtpViaProvider(env, params.phone, code);

  return { resendAfterS: RESEND_COOLDOWN_MS / 1000 };
}

/**
 * Verifies a presented code. Throws `OTP_INVALID` (wrong code, or no matching
 * challenge at all), `OTP_EXPIRED` (a challenge exists but its TTL passed), or
 * `OTP_LOCKED` (5 wrong attempts already made) — all 400 (SDD §12.2). Returns nothing;
 * callers only need to know verification succeeded (the challenge is marked consumed).
 *
 * Takes a plain `Kysely<Database>`, not a caller-supplied `Transaction` — the
 * attempts-increment on a wrong guess must survive even when the caller's own
 * surrounding transaction later rolls back (e.g. token issuance failing downstream),
 * otherwise a failed outer transaction would silently erase brute-force tracking and
 * defeat `OTP_LOCKED` entirely. Each write here commits on its own.
 *
 * Non-production test phones (`+919999900001`-`09`) always accept `123456`
 * (SDD §9.5) without needing any stored challenge at all.
 */
export async function verifyOtp(
  db: Kysely<Database>,
  params: { phone: string; code: string; purpose: OtpPurpose },
  env: Pick<Env, 'APP_ENV' | 'OTP_PEPPER'>,
  clock: Clock,
): Promise<void> {
  if (env.APP_ENV !== 'production' && isTestPhone(params.phone) && params.code === TEST_OTP_CODE) {
    return;
  }

  const now = clock.now();
  const challenge = await db
    .selectFrom('haven.otp_challenges')
    .selectAll()
    .where('phone', '=', params.phone)
    .where('purpose', '=', params.purpose)
    .where('consumed_at', 'is', null)
    .orderBy('created_at', 'desc')
    .executeTakeFirst();

  if (!challenge) {
    throw new AppError('OTP_INVALID', 400, 'Enter the code we sent you.');
  }
  if (challenge.attempts >= MAX_ATTEMPTS) {
    throw new AppError('OTP_LOCKED', 400, 'Too many incorrect attempts. Request a new code.');
  }
  if (challenge.expires_at.getTime() <= now.getTime()) {
    throw new AppError('OTP_EXPIRED', 400, 'This code has expired. Request a new one.');
  }

  const matches = otpCodeMatches(env.OTP_PEPPER, params.phone, params.code, challenge.code_hash);
  if (!matches) {
    await db
      .updateTable('haven.otp_challenges')
      .set({ attempts: challenge.attempts + 1 })
      .where('id', '=', challenge.id)
      .execute();
    throw new AppError('OTP_INVALID', 400, 'That code is incorrect.');
  }

  await db
    .updateTable('haven.otp_challenges')
    .set({ consumed_at: now.toISOString() })
    .where('id', '=', challenge.id)
    .execute();
}
