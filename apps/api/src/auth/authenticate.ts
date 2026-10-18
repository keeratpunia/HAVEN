import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Kysely } from 'kysely';
import { verifyAccessToken } from './jwt.js';
import type { Principal } from './principal.js';
import { AppError } from '../lib/errors.js';
import type { Database } from '../db/index.js';
import type { RevocationCache } from './principal-loader.js';
import { verifyDeviceToken } from '../gate/devices.js';

declare module 'fastify' {
  interface FastifyRequest {
    /**
     * Set by `authenticate` on every request (SDD §8.2 step 2, "auth (verify JWT,
     * load principal)" — this runs unconditionally, before route handlers, not just on
     * routes that need it). `null` means no credential was presented; that is not
     * itself an error — `authorize()` (apps/api/src/auth/policy.ts) decides whether
     * the specific action requires one. Routes that must have a principal regardless
     * of what `authorize()` would say should use the `requireAuth` preHandler below.
     */
    principal: Principal | null;
  }
}

export interface AuthenticateOptions {
  jwtSecretBase64: string;
  /**
   * Checks the session-revoked/user-inactive condition (SDD §9.5: "the auth hook
   * rejects tokens whose session is revoked or whose user is inactive — cached 30s").
   * Optional only so call sites with no DB (bootstrap-era infra tests) still build —
   * every real server wires one up.
   */
  revocationCache?: RevocationCache;
  /**
   * Verifies `Authorization: Device <token>` against `haven.gate_devices` (gate
   * milestone). Optional for the same reason as `revocationCache` — infra tests with
   * no DB still build; every real server wires one up.
   */
  db?: Kysely<Database>;
}

/**
 * The authentication stage of the SDD §8.2 pipeline: request ID → rate limit →
 * **auth** → validation → handler → authorize() → service → repository → serializer →
 * response. Registered as a global `onRequest` hook in `app.ts` so it runs before
 * every route, including ones not yet written.
 *
 * Header handling (SDD §12.1):
 *   - No `Authorization` header → `request.principal = null`. Most of the guest flow
 *     (invite landing, OTP request) is unauthenticated by design.
 *   - `Authorization: Bearer <jwt>` → verified via `jwt.ts`; a bad/expired token
 *     throws `AUTH_REQUIRED` (401) rather than silently falling back to `null` — the
 *     client clearly attempted to authenticate and failed, which is a different case
 *     from not trying at all.
 *   - `Authorization: Device <token>` → gate-device authentication (SDD §9.1, §12.8).
 *     Verified against `haven.gate_devices.token_hash` (`gate/devices.ts`'s
 *     `verifyDeviceToken`). A revoked or unknown token resolves to `null`, exactly
 *     like no credential at all — it does not throw, so a gate-only action still
 *     fails via `authorize()`'s normal deny path, not a different error shape.
 *   - Any other non-empty `Authorization` value → treated as a failed authentication
 *     attempt (`AUTH_REQUIRED`), not silently ignored.
 */
export function createAuthenticateHook(options: AuthenticateOptions) {
  return async function authenticate(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
    const header = request.headers.authorization;

    if (!header) {
      request.principal = null;
      return;
    }

    if (header.startsWith('Bearer ')) {
      const token = header.slice('Bearer '.length).trim();
      const claims = await verifyAccessToken(token, options.jwtSecretBase64);
      const principal: Principal =
        claims.typ === 'user'
          ? { type: 'user', userId: claims.sub, sessionId: claims.sid, roles: claims.roles }
          : { type: 'visitor', visitorId: claims.sub, sessionId: claims.sid };

      if (options.revocationCache) {
        const userId = principal.type === 'user' ? principal.userId : null;
        const { isValid, roles } = await options.revocationCache.check(principal.sessionId, userId);
        if (!isValid) {
          throw new AppError('SESSION_REVOKED', 401, 'Your session has been signed out.');
        }
        // Roles come from role_assignments (SDD §3.4), not the token claim, which can be
        // up to 15 minutes stale.
        if (principal.type === 'user') principal.roles = roles;
      }

      request.principal = principal;
      return;
    }

    if (header.startsWith('Device ')) {
      const token = header.slice('Device '.length).trim();
      if (!options.db) {
        request.principal = null;
        return;
      }
      const device = await verifyDeviceToken(options.db, token);
      request.principal = device
        ? { type: 'device', gateId: device.gateId, deviceId: device.deviceId }
        : null;
      return;
    }

    throw new AppError('AUTH_REQUIRED', 401, 'Invalid Authorization header.');
  };
}

/** Attach as a route/route-group `preHandler` to require a principal regardless of action. */
export async function requireAuth(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
  if (request.principal === null) {
    throw new AppError('AUTH_REQUIRED', 401, 'Sign in required.');
  }
}
