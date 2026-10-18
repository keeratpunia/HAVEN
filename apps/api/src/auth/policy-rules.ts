import { definePolicy } from './policy.js';
import type { Principal } from './principal.js';

/**
 * Real `authorize()` registrations for this milestone's endpoints (SDD §3.4: "every
 * handler MUST call `authorize()` — no inline role checks"). `GET/PATCH /me` and
 * `POST /me/*` are inherently self-only — but "inherently" is exactly the kind of
 * reasoning CLAUDE.md §3.10 forbids leaving as an inline `if`. The resource always
 * carries the id the caller is trying to act on; the rule is what actually denies a
 * mismatched id (a forged/stale client state, or a future bug elsewhere that passes
 * the wrong id) rather than that id merely being "obviously" the caller's own.
 */
export interface SelfResource {
  ownerType: 'user' | 'visitor';
  ownerId: string;
}

function isSelf(principal: Principal | null, resource: SelfResource): boolean {
  if (!principal) return false;
  if (principal.type === 'user' && resource.ownerType === 'user') {
    return principal.userId === resource.ownerId;
  }
  if (principal.type === 'visitor' && resource.ownerType === 'visitor') {
    return principal.visitorId === resource.ownerId;
  }
  return false;
}

/**
 * FR-09: "Guests and residents can request deletion of their account". Staff accounts
 * end through deactivation (FR-07), so a user holding any staff role is refused
 * (docs/DECISIONS.md DEC-015).
 */
export interface DeleteSelfResource extends SelfResource {
  hasStaffRole: boolean;
}

function canDeleteSelf(principal: Principal | null, resource: DeleteSelfResource): boolean {
  return isSelf(principal, resource) && !resource.hasStaffRole;
}

let registered = false;

/** Idempotent — safe to call from both app boot and tests that re-import this module. */
export function registerAuthPolicies(): void {
  if (registered) return;
  registered = true;
  definePolicy<SelfResource>('me.read', isSelf);
  definePolicy<SelfResource>('me.update', isSelf);
  definePolicy<DeleteSelfResource>('me.delete', canDeleteSelf);
  // Sign-in endpoints are open by design: the OTP, Google ID token, refresh token or
  // dev-login gate is the credential they check (SDD §9.5). The policy makes that an
  // explicit, auditable decision instead of a missing call (SECURITY-AUDIT SA-15).
  definePolicy<Record<string, never>>('auth.sign_in', () => true);
  definePolicy<Record<string, never>>('auth.logout', (p) => p !== null && p.type !== 'device');
  // F1 step 4: only a signed-in guest can claim an invite (the phone check follows).
  definePolicy<Record<string, never>>('invites.claim', (p) => p?.type === 'visitor');
}

/** Test-only: lets a test file force a clean registration against a reset registry. */
export function __resetAuthPoliciesForTests(): void {
  registered = false;
}
