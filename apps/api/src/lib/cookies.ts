import type { CookieSerializeOptions } from '@fastify/cookie';
import type { Env } from '../config.js';

/**
 * The refresh-token cookie's name and attributes, exactly as SDD §9.5 specifies:
 * `haven_rt`, httpOnly, Secure, SameSite=Lax, Path=/v1/auth, Domain=.<domain>. Defined
 * once here so the (not-yet-built) auth module's sign-in/refresh/logout routes all set
 * and clear the identical cookie rather than three slightly different literals.
 *
 * `Secure` is only set outside local dev — browsers reject `Secure` cookies over plain
 * HTTP, and local development runs on `http://localhost`.
 */
const REFRESH_COOKIE_NAME = 'haven_rt';

export function refreshCookieOptions(
  env: Pick<Env, 'APP_ENV' | 'COOKIE_DOMAIN'>,
): CookieSerializeOptions {
  return {
    httpOnly: true,
    secure: env.APP_ENV !== 'local',
    sameSite: 'lax',
    path: '/v1/auth',
    domain: env.APP_ENV === 'local' ? undefined : `.${env.COOKIE_DOMAIN}`,
  };
}

export { REFRESH_COOKIE_NAME };
