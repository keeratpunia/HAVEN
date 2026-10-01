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

let registered = false;

/** Idempotent — safe to call from both app boot and tests that re-import this module. */
export function registerAuthPolicies(): void {
  if (registered) return;
  registered = true;
  definePolicy<SelfResource>('me.read', isSelf);
  definePolicy<SelfResource>('me.update', isSelf);
}

/** Test-only: lets a test file force a clean registration against a reset registry. */
export function __resetAuthPoliciesForTests(): void {
  registered = false;
}
