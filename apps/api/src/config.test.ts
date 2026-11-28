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
    APP_ENV: 'local',
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

  const SUPABASE = {
    SUPABASE_URL: 'https://abc.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'service-role',
  };

  // FINAL-QA-REPORT D-03, SDD §9.10: photos outside local live in Supabase Storage.
  it('requires the Supabase storage settings outside local', () => {
    expect(() => loadEnv({ ...REQUIRED, APP_ENV: 'production' })).toThrow(
      /SUPABASE_URL is required outside local[\s\S]*SUPABASE_SERVICE_ROLE_KEY is required/,
    );
    __resetEnvCacheForTests();
    expect(loadEnv({ ...REQUIRED, APP_ENV: 'production', ...SUPABASE }).SUPABASE_URL).toBe(
      'https://abc.supabase.co',
    );
  });

  // FINAL-QA-REPORT D-04, SDD §9.9/§11.7: LISTEN needs a session connection, never the
  // transaction pooler. The session pooler (5432) is allowed since DEC-028.
  it('refuses a transaction-pooler DATABASE_DIRECT_URL outside local', () => {
    for (const bad of [
      'postgres://u:p@db.abc.supabase.co:6543/postgres',
      'postgres://u:p@aws-0-ap-south-1.pooler.supabase.com:6543/postgres',
      'postgres://u:p@pooler.example.com:5432/postgres?pgbouncer=true',
      'not a url',
    ]) {
      __resetEnvCacheForTests();
      expect(() =>
        loadEnv({ ...REQUIRED, APP_ENV: 'staging', ...SUPABASE, DATABASE_DIRECT_URL: bad }),
      ).toThrow(/DATABASE_DIRECT_URL must be a session connection/);
    }
    for (const good of [
      'postgres://u:p@db.abc.supabase.co:5432/postgres',
      'postgres://u.abc:p@aws-0-ap-south-1.pooler.supabase.com:5432/postgres',
    ]) {
      __resetEnvCacheForTests();
      expect(
        loadEnv({ ...REQUIRED, APP_ENV: 'staging', ...SUPABASE, DATABASE_DIRECT_URL: good })
          .DATABASE_DIRECT_URL,
      ).toBe(good);
    }
    // Local stacks may point both at one database.
    __resetEnvCacheForTests();
    expect(() =>
      loadEnv({ ...REQUIRED, DATABASE_DIRECT_URL: 'postgres://u:p@localhost:6543/postgres' }),
    ).not.toThrow();
  });

  it('refuses a SUPABASE_URL with a path (a copied .../rest/v1/ breaks every upload)', () => {
    __resetEnvCacheForTests();
    expect(() =>
      loadEnv({
        ...REQUIRED,
        APP_ENV: 'staging',
        ...SUPABASE,
        SUPABASE_URL: 'https://abc.supabase.co/rest/v1/',
      }),
    ).toThrow(/SUPABASE_URL must be just the project URL/);
    __resetEnvCacheForTests();
    expect(
      loadEnv({
        ...REQUIRED,
        APP_ENV: 'staging',
        ...SUPABASE,
        SUPABASE_URL: 'https://abc.supabase.co',
      }).SUPABASE_URL,
    ).toBe('https://abc.supabase.co');
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

  it('refuses to load without APP_ENV (fail closed, SECURITY-AUDIT SA-02)', () => {
    const { APP_ENV: _omit, ...rest } = REQUIRED;
    void _omit;
    expect(() => loadEnv(rest)).toThrow(/APP_ENV is required/);
  });

  it('rejects a wildcard or path in CORS_ORIGINS (SA-20)', () => {
    for (const bad of ['*', 'https://app.example.com,*', 'https://app.example.com/path', 'null']) {
      __resetEnvCacheForTests();
      expect(() => loadEnv({ ...REQUIRED, CORS_ORIGINS: bad })).toThrow(/CORS_ORIGINS/);
    }
  });

  it('trusts no proxy unless told how many hops (SA-10)', () => {
    expect(loadEnv(REQUIRED).TRUST_PROXY_HOPS).toBe(0);
    __resetEnvCacheForTests();
    expect(loadEnv({ ...REQUIRED, TRUST_PROXY_HOPS: '1' }).TRUST_PROXY_HOPS).toBe(1);
  });

  it('treats empty TURNSTILE_SECRET / SENTRY_DSN (as in .env.example) as unset', () => {
    const env = loadEnv({ ...REQUIRED, TURNSTILE_SECRET: '', SENTRY_DSN: '' });
    expect(env.TURNSTILE_SECRET).toBeUndefined();
    expect(env.SENTRY_DSN).toBeUndefined();
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
