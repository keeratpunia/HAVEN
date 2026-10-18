import { definePolicy } from '../auth/policy.js';
import { hasHostelRole } from '../auth/principal.js';
import type { Principal } from '../auth/principal.js';

/**
 * `authorize()` registrations for every visits-service trigger (SDD §3.4, CLAUDE.md
 * §3.10: no inline role checks). One resource shape, `VisitActorResource`, carries
 * whatever the specific action needs to check — a service function builds it from the
 * loaded visit row (or, for creation triggers, from the request) and nothing else
 * decides who's allowed to do what.
 */
export interface VisitActorResource {
  hostelId: string;
  hostUserId: string;
  visitorId: string | null;
  /** True only when this trigger fires from a scheduled job, never a user request. */
  systemTriggered?: boolean;
}

function isHost(principal: Principal | null, resource: VisitActorResource): boolean {
  return principal?.type === 'user' && principal.userId === resource.hostUserId;
}

function isTheVisitor(principal: Principal | null, resource: VisitActorResource): boolean {
  return principal?.type === 'visitor' && principal.visitorId === resource.visitorId;
}

/** Warden of the visit's hostel. SDD §3.3: approving overnight requests and force
 * check-out are "Hostel" for warden and "--" for super admin. */
function isWarden(principal: Principal | null, resource: VisitActorResource): boolean {
  return hasHostelRole(principal, resource.hostelId, ['warden']);
}

/** SDD §3.3 "See visits": warden (Hostel) and super admin (All). Office sees visits only
 * through charges, never through these endpoints. */
function canSeeHostelVisits(principal: Principal | null, resource: VisitActorResource): boolean {
  return hasHostelRole(principal, resource.hostelId, ['warden', 'super_admin']);
}

function isSystem(principal: Principal | null, resource: VisitActorResource): boolean {
  return resource.systemTriggered === true && principal === null;
}

let registered = false;

/** Idempotent — safe to call from both app boot and tests. */
export function registerVisitPolicies(): void {
  if (registered) return;
  registered = true;

  // Reading a visit: the host, the guest it's for, or a warden of its hostel.
  definePolicy<VisitActorResource>(
    'visits.read',
    (p, r) => isHost(p, r) || isTheVisitor(p, r) || canSeeHostelVisits(p, r),
  );

  definePolicy<VisitActorResource>('visits.pre_invite_created', isHost);
  definePolicy<VisitActorResource>('visits.walk_in_requested', (p, r) => isTheVisitor(p, r));
  definePolicy<VisitActorResource>('visits.overnight_requested', isHost);
  definePolicy<VisitActorResource>('visits.host_assisted_entry', isHost);

  definePolicy<VisitActorResource>('visits.host_approves_walk_in', isHost);
  definePolicy<VisitActorResource>('visits.host_rejects_walk_in', isHost);
  definePolicy<VisitActorResource>('visits.walk_in_timeout', isSystem);
  definePolicy<VisitActorResource>('visits.guest_cancels_walk_in', isTheVisitor);

  definePolicy<VisitActorResource>('visits.warden_approves_overnight', isWarden);
  definePolicy<VisitActorResource>('visits.warden_rejects_overnight', isWarden);
  definePolicy<VisitActorResource>('visits.host_cancels_overnight_request', isHost);

  // Check-in: the guest themself, or the host confirming presence for them (SDD F3,
  // "location not verified ... host taps Confirm").
  definePolicy<VisitActorResource>('visits.check_in', (p, r) => isTheVisitor(p, r) || isHost(p, r));

  // Cancel of an approved visit: the host, or the system (host suspended / guest banned).
  definePolicy<VisitActorResource>(
    'visits.cancel_approved',
    (p, r) => isHost(p, r) || isSystem(p, r),
  );
  definePolicy<VisitActorResource>('visits.window_expired_no_entry', isSystem);
  definePolicy<VisitActorResource>('visits.window_ended_after_entry', isSystem);

  // Check-out: guest or host (SDD F5: "Inside guest scans the gate QR ... App shows
  // Check out"; host can also act for a guest without a phone, host-assisted).
  definePolicy<VisitActorResource>(
    'visits.check_out_step_out',
    (p, r) => isTheVisitor(p, r) || isHost(p, r),
  );
  definePolicy<VisitActorResource>(
    'visits.check_out_final',
    (p, r) => isTheVisitor(p, r) || isHost(p, r),
  );
  definePolicy<VisitActorResource>('visits.host_marks_guest_left', isHost);
  definePolicy<VisitActorResource>('visits.warden_forces_checkout', isWarden);

  // SDD §12.6 host-only actions that aren't a §7.1 status transition of their own.
  definePolicy<VisitActorResource>('visits.confirm_arrival', isHost);
  definePolicy<VisitActorResource>('visits.dispute', isHost);
  definePolicy<VisitActorResource>('visits.edit_window', isHost);
  definePolicy<VisitActorResource>('visits.invite_link', isHost);
  definePolicy<VisitActorResource>('visits.preview', isHost);
}

/** Test-only: lets a test file force a clean registration against a reset registry. */
export function __resetVisitPoliciesForTests(): void {
  registered = false;
}
