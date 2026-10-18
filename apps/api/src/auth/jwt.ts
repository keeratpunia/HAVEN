import { jwtVerify, SignJWT, errors as joseErrors } from 'jose';
import { AppError } from '../lib/errors.js';

/**
 * Access JWT issue/verify (SDD §9.5). HS256, 15 minute lifetime, claims exactly as
 * specified: `sub`, `typ` (`user`|`visitor`), `sid`, `roles` (`[{h: hostelId, r: role}]`),
 * `iss: 'haven-api'`, `aud: 'haven'`.
 *
 * This module only handles the token itself — issuing one still requires a caller
 * (the future OTP/Google sign-in handlers) to have already decided who the principal
 * is and what their `sid`/`roles` are. No sign-in flow is implemented here.
 */

const ISSUER = 'haven-api';
const AUDIENCE = 'haven';
const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;

export interface RoleGrant {
  /** Hostel id, or `ALL_HOSTELS` for a super admin (role_assignments.hostel_id is null). */
  h: string;
  r: 'super_admin' | 'warden' | 'office';
}

/** SDD §3: roles are granted per hostel "never globally (except super admin)". */
export const ALL_HOSTELS = '*';

export interface AccessTokenClaims {
  sub: string;
  typ: 'user' | 'visitor';
  sid: string;
  roles: RoleGrant[];
}

export interface VerifiedAccessToken extends AccessTokenClaims {
  exp: number;
  iat: number;
}

function getSigningKey(jwtSecretBase64: string): Uint8Array {
  return new Uint8Array(Buffer.from(jwtSecretBase64, 'base64'));
}

export async function signAccessToken(
  claims: AccessTokenClaims,
  jwtSecretBase64: string,
): Promise<string> {
  const key = getSigningKey(jwtSecretBase64);
  return new SignJWT({ typ: claims.typ, sid: claims.sid, roles: claims.roles })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(claims.sub)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(`${ACCESS_TOKEN_TTL_SECONDS}s`)
    .sign(key);
}

/**
 * Verifies an access token. Throws `AppError('AUTH_REQUIRED', 401, ...)` for any
 * failure (expired, wrong signature, wrong issuer/audience, malformed claims) — the
 * caller (the authentication hook) never needs to distinguish *why* a token failed,
 * only that it did (SDD §12.2: `AUTH_REQUIRED` covers "missing/expired access token").
 */
export async function verifyAccessToken(
  token: string,
  jwtSecretBase64: string,
): Promise<VerifiedAccessToken> {
  const key = getSigningKey(jwtSecretBase64);
  try {
    const { payload } = await jwtVerify(token, key, { issuer: ISSUER, audience: AUDIENCE });
    return parseClaims(payload);
  } catch (err) {
    if (
      err instanceof joseErrors.JWTExpired ||
      err instanceof joseErrors.JWSSignatureVerificationFailed
    ) {
      throw new AppError('AUTH_REQUIRED', 401, 'Your session has expired. Please sign in again.');
    }
    throw new AppError('AUTH_REQUIRED', 401, 'Invalid access token.');
  }
}

function parseClaims(payload: Record<string, unknown>): VerifiedAccessToken {
  const { sub, typ, sid, roles, exp, iat } = payload;
  if (
    typeof sub !== 'string' ||
    (typ !== 'user' && typ !== 'visitor') ||
    typeof sid !== 'string' ||
    !Array.isArray(roles) ||
    typeof exp !== 'number' ||
    typeof iat !== 'number'
  ) {
    throw new AppError('AUTH_REQUIRED', 401, 'Invalid access token.');
  }
  return { sub, typ, sid, roles: roles as RoleGrant[], exp, iat };
}
