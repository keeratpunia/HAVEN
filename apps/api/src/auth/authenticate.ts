import type { FastifyReply, FastifyRequest } from 'fastify';
import { verifyAccessToken } from './jwt.js';
import type { Principal } from './principal.js';
import { AppError } from '../lib/errors.js';

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
 *     Recognized here so the shape exists, but **not implemented** — verifying it
 *     needs a typed query against `haven.gate_devices`, which doesn't exist until the
 *     gate module (M2, see docs/IMPLEMENTATION-PLAN.md). Resolves to `null` for now;
 *     do not read that as "device auth works," it means no gate-scoped action can
 *     succeed yet, which is the safe failure direction.
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
      request.principal =
        claims.typ === 'user'
          ? { type: 'user', userId: claims.sub, sessionId: claims.sid, roles: claims.roles }
          : { type: 'visitor', visitorId: claims.sub, sessionId: claims.sid };
      return;
    }

    if (header.startsWith('Device ')) {
      // See module comment: device-token verification is M2 work.
      request.principal = null;
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
