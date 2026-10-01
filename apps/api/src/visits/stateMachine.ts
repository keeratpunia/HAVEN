import { AppError } from '../lib/errors.js';

/**
 * The HAVEN visit state machine (SDD §7, §7.1): "visits.status has eight values;
 * overstay, dispute and unverified location are flags (columns), not states ... Only
 * the API changes status, inside one database transaction that also writes the gate
 * event and audit row." This file is the single transition map SDD §7.1 names
 * explicitly ("Implement as a single map in apps/api/src/visits/stateMachine.ts") and
 * nothing else — no I/O, no DB, no clock. Every transition in SDD §7.1's table is
 * here; nothing else is. "Any transition not listed here MUST be rejected with 409
 * INVALID_TRANSITION."
 *
 * `'new'` is not a real `haven.visit_status` value — it stands for "the visit row
 * doesn't exist yet" so the four creation rows in the SDD's table (`(new) → ...`) fit
 * the same `{from, trigger} -> to` shape as the other fifteen, instead of being a
 * separate, parallel mechanism that could drift from this one.
 */

export type VisitStatus =
  | 'pending_host'
  | 'pending_warden'
  | 'approved'
  | 'inside'
  | 'completed'
  | 'rejected'
  | 'expired'
  | 'cancelled';

export const VISIT_STATUSES: readonly VisitStatus[] = [
  'pending_host',
  'pending_warden',
  'approved',
  'inside',
  'completed',
  'rejected',
  'expired',
  'cancelled',
];

/**
 * One member per row of SDD §7.1's table, named for the "Trigger" column. The service
 * layer has exactly one function per trigger; each calls `assertTransition` with its
 * own trigger name before doing anything else, so a service function can never
 * accidentally perform a transition its own name doesn't describe.
 */
export type VisitTrigger =
  | 'pre_invite_created'
  | 'walk_in_requested'
  | 'overnight_requested'
  | 'host_assisted_entry'
  | 'host_approves_walk_in'
  | 'host_rejects_walk_in'
  | 'walk_in_timeout'
  | 'guest_cancels_walk_in'
  | 'warden_approves_overnight'
  | 'warden_rejects_overnight'
  | 'host_cancels_overnight_request'
  | 'check_in'
  | 'cancel_approved'
  | 'window_expired_no_entry'
  | 'window_ended_after_entry'
  | 'check_out_step_out'
  | 'check_out_final'
  | 'host_marks_guest_left'
  | 'warden_forces_checkout';

export interface VisitTransition {
  from: VisitStatus | 'new';
  to: VisitStatus;
  trigger: VisitTrigger;
}

/** The literal table from SDD §7.1 — row order matches the SDD's own row order. */
export const VISIT_TRANSITIONS: readonly VisitTransition[] = [
  { from: 'new', to: 'approved', trigger: 'pre_invite_created' },
  { from: 'new', to: 'pending_host', trigger: 'walk_in_requested' },
  { from: 'new', to: 'pending_warden', trigger: 'overnight_requested' },
  { from: 'new', to: 'inside', trigger: 'host_assisted_entry' },
  { from: 'pending_host', to: 'inside', trigger: 'host_approves_walk_in' },
  { from: 'pending_host', to: 'rejected', trigger: 'host_rejects_walk_in' },
  { from: 'pending_host', to: 'expired', trigger: 'walk_in_timeout' },
  { from: 'pending_host', to: 'cancelled', trigger: 'guest_cancels_walk_in' },
  { from: 'pending_warden', to: 'approved', trigger: 'warden_approves_overnight' },
  { from: 'pending_warden', to: 'rejected', trigger: 'warden_rejects_overnight' },
  { from: 'pending_warden', to: 'cancelled', trigger: 'host_cancels_overnight_request' },
  { from: 'approved', to: 'inside', trigger: 'check_in' },
  { from: 'approved', to: 'cancelled', trigger: 'cancel_approved' },
  { from: 'approved', to: 'expired', trigger: 'window_expired_no_entry' },
  { from: 'approved', to: 'completed', trigger: 'window_ended_after_entry' },
  { from: 'inside', to: 'approved', trigger: 'check_out_step_out' },
  { from: 'inside', to: 'completed', trigger: 'check_out_final' },
  { from: 'inside', to: 'completed', trigger: 'host_marks_guest_left' },
  { from: 'inside', to: 'completed', trigger: 'warden_forces_checkout' },
];

/** Pure lookup — returns `undefined` if `{from, trigger}` isn't in the table. */
export function findTransition(
  from: VisitStatus | 'new',
  trigger: VisitTrigger,
): VisitTransition | undefined {
  return VISIT_TRANSITIONS.find((t) => t.from === from && t.trigger === trigger);
}

/**
 * The single gate every visits-service mutation calls before doing anything else
 * (SDD §7.1's own "MUST be rejected" wording — step 1 of the per-transition checklist,
 * "validate the current state"). Throws `AppError('INVALID_TRANSITION', 409, ...)` for
 * any `{from, trigger}` not in `VISIT_TRANSITIONS`; returns the matched transition
 * (so the caller has `to` without a second lookup) otherwise.
 */
export function assertTransition(
  from: VisitStatus | 'new',
  trigger: VisitTrigger,
): VisitTransition {
  const transition = findTransition(from, trigger);
  if (!transition) {
    throw new AppError(
      'INVALID_TRANSITION',
      409,
      `Cannot ${trigger} from ${from === 'new' ? 'a new visit' : `status ${from}`}.`,
      { from, trigger },
    );
  }
  return transition;
}

/** True if `from -> to` is reachable via *any* trigger — used only for exhaustive tests. */
export function isReachable(from: VisitStatus | 'new', to: VisitStatus): boolean {
  return VISIT_TRANSITIONS.some((t) => t.from === from && t.to === to);
}
