import { describe, expect, it } from 'vitest';
import { REFRESH_COOKIE_NAME, refreshCookieOptions } from './cookies.js';

describe('refresh cookie (SDD §9.5)', () => {
  it('is named haven_rt', () => {
    expect(REFRESH_COOKIE_NAME).toBe('haven_rt');
  });

  it('is httpOnly, SameSite=Lax, scoped to /v1/auth', () => {
    const options = refreshCookieOptions({ APP_ENV: 'production', COOKIE_DOMAIN: 'haven-gh8.in' });
    expect(options.httpOnly).toBe(true);
    expect(options.sameSite).toBe('lax');
    expect(options.path).toBe('/v1/auth');
  });

  it('is Secure outside local dev, with a domain scoped to .<domain>', () => {
    const options = refreshCookieOptions({ APP_ENV: 'production', COOKIE_DOMAIN: 'haven-gh8.in' });
    expect(options.secure).toBe(true);
    expect(options.domain).toBe('.haven-gh8.in');
  });

  it('is not Secure in local dev (plain HTTP), and has no cross-subdomain domain attribute', () => {
    const options = refreshCookieOptions({ APP_ENV: 'local', COOKIE_DOMAIN: 'localhost' });
    expect(options.secure).toBe(false);
    expect(options.domain).toBeUndefined();
  });

  it('is Secure in staging too, not just production', () => {
    const options = refreshCookieOptions({
      APP_ENV: 'staging',
      COOKIE_DOMAIN: 'staging.haven-gh8.in',
    });
    expect(options.secure).toBe(true);
  });
});
