import { beforeEach, describe, expect, it } from 'vitest';
import { __resetEnvCacheForTests, loadEnv } from './config.js';

describe('loadEnv', () => {
  beforeEach(() => {
    __resetEnvCacheForTests();
  });

  const VALID_JWT_SECRET = Buffer.alloc(32, 7).toString('base64');

  it('loads valid config with required vars present', () => {
    const env = loadEnv({
      DATABASE_URL: 'postgres://user:pass@localhost:6543/postgres',
      DATABASE_DIRECT_URL: 'postgres://user:pass@localhost:5432/postgres',
      JWT_SECRET: VALID_JWT_SECRET,
    });
    expect(env.APP_ENV).toBe('local');
    expect(env.PORT).toBe(8080);
    expect(env.CORS_ORIGINS).toEqual(['http://localhost:8081']);
  });

  it('parses a comma-separated CORS_ORIGINS list', () => {
    const env = loadEnv({
      DATABASE_URL: 'postgres://x',
      DATABASE_DIRECT_URL: 'postgres://y',
      JWT_SECRET: VALID_JWT_SECRET,
      CORS_ORIGINS: 'https://app.haven-gh8.in, http://localhost:8081',
    });
    expect(env.CORS_ORIGINS).toEqual(['https://app.haven-gh8.in', 'http://localhost:8081']);
  });

  it('throws (stops boot) when DATABASE_URL is missing', () => {
    expect(() =>
      loadEnv({ DATABASE_DIRECT_URL: 'postgres://y', JWT_SECRET: VALID_JWT_SECRET }),
    ).toThrow(/DATABASE_URL/);
  });

  it('rejects an invalid APP_ENV value', () => {
    expect(() =>
      loadEnv({
        DATABASE_URL: 'postgres://x',
        DATABASE_DIRECT_URL: 'postgres://y',
        JWT_SECRET: VALID_JWT_SECRET,
        APP_ENV: 'not-a-real-env',
      }),
    ).toThrow();
  });

  it('throws when JWT_SECRET is missing', () => {
    expect(() =>
      loadEnv({
        DATABASE_URL: 'postgres://x',
        DATABASE_DIRECT_URL: 'postgres://y',
      }),
    ).toThrow(/JWT_SECRET/);
  });

  it('throws when JWT_SECRET decodes to fewer than 32 bytes', () => {
    expect(() =>
      loadEnv({
        DATABASE_URL: 'postgres://x',
        DATABASE_DIRECT_URL: 'postgres://y',
        JWT_SECRET: Buffer.alloc(8).toString('base64'),
      }),
    ).toThrow(/32 bytes/);
  });
});
