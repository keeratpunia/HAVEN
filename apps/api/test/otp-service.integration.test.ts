import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getTestDb, resetAllHavenTables, freshOtpPepperBase64 } from './db-test-helper.js';
import { requestOtp, verifyOtp } from '../src/auth/otp-service.js';
import { FakeClock } from '../src/lib/clock.js';
import { hashOtpCode } from '../src/auth/otp.js';

const db = getTestDb();
const OTP_PEPPER = freshOtpPepperBase64();
const env = { SMS_PROVIDER: 'console' as const, APP_ENV: 'local' as const, OTP_PEPPER };

async function readLatestCode(
  phone: string,
): Promise<{ code_hash: Buffer; attempts: number; expires_at: Date }> {
  const row = await db
    .selectFrom('haven.otp_challenges')
    .selectAll()
    .where('phone', '=', phone)
    .orderBy('created_at', 'desc')
    .executeTakeFirstOrThrow();
  return row;
}

describe('OTP request/verify (SDD §9.5)', () => {
  beforeEach(async () => {
    await resetAllHavenTables();
  });

  it('valid authentication: request then verify with the printed code succeeds end to end', async () => {
    const clock = new FakeClock(new Date('2026-10-01T10:00:00Z'));
    const phone = '+919876500001';

    // The "console" provider's dev-only delivery channel IS the printed code — reading
    // it back the same way a developer would is the only way to exercise the real,
    // public `requestOtp` → `verifyOtp` round trip (the code is never returned).
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await requestOtp(db, { phone, purpose: 'guest_login', ip: '1.2.3.4' }, env, clock);
    const printed = logSpy.mock.calls
      .map((args) => String(args[0]))
      .find((line) => line.includes(phone));
    logSpy.mockRestore();
    expect(printed).toBeDefined();
    const match = printed?.match(/purpose-code=(\d{6})/);
    if (!match) throw new Error('expected the dev OTP log line to contain a 6-digit code');
    const code = match[1];
    expect(code).toMatch(/^[0-9]{6}$/);

    const stored = await readLatestCode(phone);
    expect(stored.attempts).toBe(0);
    expect(stored.expires_at.getTime()).toBe(clock.now().getTime() + 5 * 60 * 1000);

    await verifyOtp(db, { phone, code, purpose: 'guest_login' }, env, clock);
  });

  it('invalid credentials: wrong code is rejected with OTP_INVALID and increments attempts', async () => {
    const clock = new FakeClock(new Date('2026-10-01T10:00:00Z'));
    await requestOtp(
      db,
      { phone: '+919876500002', purpose: 'guest_login', ip: '1.2.3.4' },
      env,
      clock,
    );

    await expect(
      verifyOtp(db, { phone: '+919876500002', code: '000000', purpose: 'guest_login' }, env, clock),
    ).rejects.toMatchObject({ code: 'OTP_INVALID', httpStatus: 400 });

    const after = await readLatestCode('+919876500002');
    expect(after.attempts).toBe(1);
  });

  it('no challenge at all is OTP_INVALID, not a 500', async () => {
    const clock = new FakeClock(new Date('2026-10-01T10:00:00Z'));
    await expect(
      verifyOtp(db, { phone: '+919876500099', code: '123456', purpose: 'guest_login' }, env, clock),
    ).rejects.toMatchObject({ code: 'OTP_INVALID' });
  });

  it('expired credentials: a code past its 5-minute TTL is OTP_EXPIRED', async () => {
    const clock = new FakeClock(new Date('2026-10-01T10:00:00Z'));
    await requestOtp(
      db,
      { phone: '+919876500003', purpose: 'guest_login', ip: '1.2.3.4' },
      env,
      clock,
    );
    clock.advance(5 * 60 * 1000 + 1000);

    await expect(
      verifyOtp(db, { phone: '+919876500003', code: '123456', purpose: 'guest_login' }, env, clock),
    ).rejects.toMatchObject({ code: 'OTP_EXPIRED', httpStatus: 400 });
  });

  it('OTP brute-force protection: the 6th wrong attempt is OTP_LOCKED', async () => {
    const clock = new FakeClock(new Date('2026-10-01T10:00:00Z'));
    await requestOtp(
      db,
      { phone: '+919876500004', purpose: 'guest_login', ip: '1.2.3.4' },
      env,
      clock,
    );

    for (let i = 0; i < 5; i++) {
      await expect(
        verifyOtp(
          db,
          { phone: '+919876500004', code: '000000', purpose: 'guest_login' },
          env,
          clock,
        ),
      ).rejects.toMatchObject({ code: 'OTP_INVALID' });
    }

    await expect(
      verifyOtp(db, { phone: '+919876500004', code: '000000', purpose: 'guest_login' }, env, clock),
    ).rejects.toMatchObject({ code: 'OTP_LOCKED', httpStatus: 400 });
  });

  it('a correct code (reconstructed via the same hash the service stored) verifies successfully exactly once', async () => {
    const clock = new FakeClock(new Date('2026-10-01T10:00:00Z'));
    // Bypass provider delivery to get the plaintext code deterministically for the
    // test: insert the challenge directly with a known code, exactly as requestOtp
    // would, then verify through the real verifyOtp path.
    const phone = '+919876500005';
    const code = '424242';
    await db
      .insertInto('haven.otp_challenges')
      .values({
        phone,
        purpose: 'guest_login',
        code_hash: hashOtpCode(OTP_PEPPER, phone, code),
        created_at: clock.now(),
        expires_at: new Date(clock.now().getTime() + 5 * 60 * 1000),
      })
      .execute();

    await verifyOtp(db, { phone, code, purpose: 'guest_login' }, env, clock);

    const consumed = await readLatestCode(phone);
    expect(consumed).toBeDefined();
    // Re-using the same (now consumed) code must fail — a fresh lookup finds no
    // unconsumed challenge.
    await expect(
      verifyOtp(db, { phone, code, purpose: 'guest_login' }, env, clock),
    ).rejects.toMatchObject({
      code: 'OTP_INVALID',
    });
  });

  it('non-production test phones accept the fixed code 123456 with no stored challenge at all', async () => {
    const clock = new FakeClock(new Date('2026-10-01T10:00:00Z'));
    await verifyOtp(
      db,
      { phone: '+919999900005', code: '123456', purpose: 'guest_login' },
      env,
      clock,
    );
  });

  it('test phones do NOT bypass in production (APP_ENV=production)', async () => {
    const clock = new FakeClock(new Date('2026-10-01T10:00:00Z'));
    const prodEnv = { ...env, APP_ENV: 'production' as const };
    await expect(
      verifyOtp(
        db,
        { phone: '+919999900005', code: '123456', purpose: 'guest_login' },
        prodEnv,
        clock,
      ),
    ).rejects.toMatchObject({ code: 'OTP_INVALID' });
  });

  it('rate limiting: the 4th request for the same phone within 10 minutes is RATE_LIMITED', async () => {
    const clock = new FakeClock(new Date('2026-10-01T10:00:00Z'));
    const phone = '+919876500006';
    await requestOtp(db, { phone, purpose: 'guest_login', ip: '9.9.9.1' }, env, clock);
    clock.advance(31_000);
    await requestOtp(db, { phone, purpose: 'guest_login', ip: '9.9.9.2' }, env, clock);
    clock.advance(31_000);
    await requestOtp(db, { phone, purpose: 'guest_login', ip: '9.9.9.3' }, env, clock);
    clock.advance(31_000);

    await expect(
      requestOtp(db, { phone, purpose: 'guest_login', ip: '9.9.9.4' }, env, clock),
    ).rejects.toMatchObject({
      code: 'RATE_LIMITED',
      httpStatus: 429,
    });
  });

  it('rate limiting: the 11th request from one IP within an hour is RATE_LIMITED (distinct phones)', async () => {
    const clock = new FakeClock(new Date('2026-10-01T10:00:00Z'));
    const ip = '9.9.9.9';
    for (let i = 0; i < 10; i++) {
      await requestOtp(
        db,
        { phone: `+9198765001${String(i).padStart(2, '0')}`, purpose: 'guest_login', ip },
        env,
        clock,
      );
      clock.advance(1000);
    }
    await expect(
      requestOtp(db, { phone: '+919876500199', purpose: 'guest_login', ip }, env, clock),
    ).rejects.toMatchObject({
      code: 'RATE_LIMITED',
      httpStatus: 429,
    });
  });

  it('resend cooldown: requesting again inside 30s is RATE_LIMITED', async () => {
    const clock = new FakeClock(new Date('2026-10-01T10:00:00Z'));
    const phone = '+919876500007';
    await requestOtp(db, { phone, purpose: 'guest_login', ip: '1.1.1.1' }, env, clock);
    clock.advance(10_000);
    await expect(
      requestOtp(db, { phone, purpose: 'guest_login', ip: '1.1.1.1' }, env, clock),
    ).rejects.toMatchObject({
      code: 'RATE_LIMITED',
    });
  });

  it('resend is allowed after 30s', async () => {
    const clock = new FakeClock(new Date('2026-10-01T10:00:00Z'));
    const phone = '+919876500008';
    await requestOtp(db, { phone, purpose: 'guest_login', ip: '1.1.1.2' }, env, clock);
    clock.advance(31_000);
    const result = await requestOtp(
      db,
      { phone, purpose: 'guest_login', ip: '1.1.1.2' },
      env,
      clock,
    );
    expect(result.resendAfterS).toBe(30);
  });

  it('throws if asked to use SMS_PROVIDER=console in production (fails closed, never silently sends)', async () => {
    const clock = new FakeClock(new Date('2026-10-01T10:00:00Z'));
    await expect(
      requestOtp(
        db,
        { phone: '+919876500009', purpose: 'guest_login', ip: '1.1.1.3' },
        { ...env, APP_ENV: 'production' },
        clock,
      ),
    ).rejects.toThrow(/production/);
  });
});
