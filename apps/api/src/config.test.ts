import { beforeEach, describe, expect, it } from 'vitest';
import { __resetEnvCacheForTests, loadEnv } from './config.js';

describe('loadEnv', () => {
  beforeEach(() => {
    __resetEnvCacheForTests();
  });

  const VALID_JWT_SECRET = Buffer.alloc(32, 7).toString('base64');
  const VALID_OTP_PEPPER = Buffer.alloc(32, 3).toString('base64');
  const VALID_DATA_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString('base64');
  const REQUIRED = {
    DATABASE_URL: 'postgres://user:pass@localhost:6543/postgres',
    DATABASE_DIRECT_URL: 'postgres://user:pass@localhost:5432/postgres',
    JWT_SECRET: VALID_JWT_SECRET,
    OTP_PEPPER: VALID_OTP_PEPPER,
    GOOGLE_CLIENT_IDS: 'web-client-id',
    DATA_ENCRYPTION_KEY: VALID_DATA_ENCRYPTION_KEY,
  };

  it('loads valid config with required vars present', () => {
    const env = loadEnv(REQUIRED);
    expect(env.APP_ENV).toBe('local');
    expect(env.PORT).toBe(8080);
    expect(env.CORS_ORIGINS).toEqual(['http://localhost:8081']);
    expect(env.SMS_PROVIDER).toBe('console');
  });

  it('parses a comma-separated CORS_ORIGINS list', () => {
    const env = loadEnv({
      ...REQUIRED,
      CORS_ORIGINS: 'https://app.haven-gh8.in, http://localhost:8081',
    });
    expect(env.CORS_ORIGINS).toEqual(['https://app.haven-gh8.in', 'http://localhost:8081']);
  });

  it('parses a comma-separated GOOGLE_CLIENT_IDS list', () => {
    const env = loadEnv({ ...REQUIRED, GOOGLE_CLIENT_IDS: 'web-id, android-id' });
    expect(env.GOOGLE_CLIENT_IDS).toEqual(['web-id', 'android-id']);
  });

  it('throws (stops boot) when DATABASE_URL is missing', () => {
    const { DATABASE_URL: _omit, ...rest } = REQUIRED;
    expect(() => loadEnv(rest)).toThrow(/DATABASE_URL/);
  });

  it('rejects an invalid APP_ENV value', () => {
    expect(() => loadEnv({ ...REQUIRED, APP_ENV: 'not-a-real-env' })).toThrow();
  });

  it('throws when JWT_SECRET is missing', () => {
    const { JWT_SECRET: _omit, ...rest } = REQUIRED;
    expect(() => loadEnv(rest)).toThrow(/JWT_SECRET/);
  });

  it('throws when JWT_SECRET decodes to fewer than 32 bytes', () => {
    expect(() => loadEnv({ ...REQUIRED, JWT_SECRET: Buffer.alloc(8).toString('base64') })).toThrow(
      /32 bytes/,
    );
  });

  it('throws when OTP_PEPPER is missing', () => {
    const { OTP_PEPPER: _omit, ...rest } = REQUIRED;
    expect(() => loadEnv(rest)).toThrow(/OTP_PEPPER/);
  });

  it('throws when OTP_PEPPER decodes to fewer than 32 bytes', () => {
    expect(() => loadEnv({ ...REQUIRED, OTP_PEPPER: Buffer.alloc(8).toString('base64') })).toThrow(
      /32 bytes/,
    );
  });

  it('throws when GOOGLE_CLIENT_IDS is missing', () => {
    const { GOOGLE_CLIENT_IDS: _omit, ...rest } = REQUIRED;
    expect(() => loadEnv(rest)).toThrow(/GOOGLE_CLIENT_IDS/);
  });

  it('rejects an invalid SMS_PROVIDER value', () => {
    expect(() => loadEnv({ ...REQUIRED, SMS_PROVIDER: 'twilio' })).toThrow();
  });
});
