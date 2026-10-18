import { definePolicy } from '../auth/policy.js';
import { hasHostelRole } from '../auth/principal.js';
import type { Principal } from '../auth/principal.js';

/**
 * `authorize()` registrations for the gate module's warden-scoped actions (SDD §3.4,
 * CLAUDE.md §3.10). The guest-facing scan-session endpoints
 * (`/scan-sessions/*`) are bound by nonce + principal binding instead (SDD §9.3
 * "Binding") — a different authorization primitive, enforced by
 * `scanSessions.ts`'s `validateAndBindSession`, not this registry. Check-in/check-out/
 * walk-in/host-assisted actions delegate to the visits module's own
 * `authorize('visits.*', ...)` calls inside `visits/service.ts` — this file does not
 * re-register those.
 */
export interface GateActorResource {
  hostelId: string;
}

function isWarden(principal: Principal | null, resource: GateActorResource): boolean {
  return hasHostelRole(principal, resource.hostelId, ['warden', 'super_admin']);
}

/** §12.7 room search: only for the caller's own live scan session, at that hostel's gate. */
export interface ResidentSearchResource {
  sessionVisitorId: string | null;
  sessionHostelId: string;
  hostelId: string;
}

function canSearchResidents(principal: Principal | null, r: ResidentSearchResource): boolean {
  return (
    principal?.type === 'visitor' &&
    r.sessionVisitorId === principal.visitorId &&
    r.sessionHostelId === r.hostelId
  );
}

let registered = false;

/** Idempotent — safe to call from both app boot and tests. */
export function registerGatePolicies(): void {
  if (registered) return;
  registered = true;

  definePolicy<GateActorResource>('gate.create_pairing_code', isWarden);
  definePolicy<GateActorResource>('gate.revoke_device', isWarden);
  definePolicy<ResidentSearchResource>('gate.search_residents', canSearchResidents);
}

/** Test-only: lets a test file force a clean registration against a reset registry. */
export function __resetGatePoliciesForTests(): void {
  registered = false;
}
