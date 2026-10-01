import type { RoleGrant } from './jwt.js';

/**
 * The authenticated caller of a request. A discriminated union, not a loose object —
 * every policy check and serializer should narrow on `.type` rather than checking
 * optional fields (SDD §3: five human roles plus the gate-device machine principal).
 *
 * `null` means "no credential was presented." That is a valid, common state (public
 * endpoints, the first steps of OTP sign-in) — it is `authorize()`'s job to decide
 * whether a given action requires more than that, not the authentication hook's.
 */
export type Principal = UserPrincipal | VisitorPrincipal | DevicePrincipal;

export interface UserPrincipal {
  type: 'user';
  userId: string;
  sessionId: string;
  roles: RoleGrant[];
}

export interface VisitorPrincipal {
  type: 'visitor';
  visitorId: string;
  sessionId: string;
}

/**
 * A paired gate device (SDD §9.1, §12.8). Verifying a real `Authorization: Device
 * <token>` header against `haven.gate_devices` is gate-module work (M2) — this type
 * exists now so the authentication hook and `authorize()` have a stable shape to
 * target, per `apps/api/src/auth/authenticate.ts`'s module comment.
 */
export interface DevicePrincipal {
  type: 'device';
  gateId: string;
  deviceId: string;
}

export function hasHostelRole(
  principal: Principal | null,
  hostelId: string,
  roles: RoleGrant['r'][],
): boolean {
  if (principal?.type !== 'user') return false;
  return principal.roles.some((grant) => grant.h === hostelId && roles.includes(grant.r));
}
