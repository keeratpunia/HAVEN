import { describe, expect, it } from 'vitest';
import { generateOtpCode, hashOtpCode, isTestPhone, otpCodeMatches, TEST_OTP_CODE } from './otp.js';

const PEPPER = Buffer.alloc(32, 7).toString('base64');

describe('generateOtpCode', () => {
  it('always returns a 6-digit string', () => {
    for (let i = 0; i < 200; i++) {
      const code = generateOtpCode();
      expect(code).toMatch(/^[0-9]{6}$/);
    }
  });
});

describe('hashOtpCode / otpCodeMatches', () => {
  it('is deterministic for the same pepper/phone/code', () => {
    const a = hashOtpCode(PEPPER, '+919876543210', '123456');
    const b = hashOtpCode(PEPPER, '+919876543210', '123456');
    expect(a.equals(b)).toBe(true);
  });

  it('differs for a different phone or code', () => {
    const base = hashOtpCode(PEPPER, '+919876543210', '123456');
    expect(hashOtpCode(PEPPER, '+919876543211', '123456').equals(base)).toBe(false);
    expect(hashOtpCode(PEPPER, '+919876543210', '654321').equals(base)).toBe(false);
  });

  it('otpCodeMatches verifies a correct code and rejects an incorrect one', () => {
    const stored = hashOtpCode(PEPPER, '+919876543210', '123456');
    expect(otpCodeMatches(PEPPER, '+919876543210', '123456', stored)).toBe(true);
    expect(otpCodeMatches(PEPPER, '+919876543210', '000000', stored)).toBe(false);
  });
});

describe('isTestPhone (SDD §9.5, non-production only)', () => {
  it('recognizes +919999900001 through +919999900009', () => {
    for (let n = 1; n <= 9; n++) {
      expect(isTestPhone(`+91999990000${n}`)).toBe(true);
    }
  });

  it('rejects +919999900000 and +919999900010', () => {
    expect(isTestPhone('+919999900000')).toBe(false);
    expect(isTestPhone('+919999900010')).toBe(false);
  });

  it('rejects an ordinary phone number', () => {
    expect(isTestPhone('+919876543210')).toBe(false);
  });

  it('TEST_OTP_CODE is the fixed 6-digit code', () => {
    expect(TEST_OTP_CODE).toBe('123456');
  });
});
