import type { Gender, Zone } from './config.js';

export type { Gender, HostelGender, Zone, VisitType } from './config.js';

/** SDD §4.4: `type Decision = 'allow' | 'allow_flagged' | 'deny';` */
export type Decision = 'allow' | 'allow_flagged' | 'deny';

/**
 * Every code the rules engine can produce, across all three evaluate* functions (SDD
 * §4.5). One union so a caller can exhaustively switch on `RuleResult.codes` without
 * needing to know which function produced them.
 */
export type RuleCode =
  // evaluateCreate deny codes (SDD §4.5, in evaluation order)
  | 'HOST_NOT_VERIFIED'
  | 'HOST_SUSPENDED'
  | 'VISITOR_BANNED'
  | 'TYPE_NOT_ALLOWED_FOR_GENDER'
  | 'WINDOW_INVALID'
  | 'TOO_FAR_AHEAD'
  | 'OVERNIGHT_OVERLAP'
  | 'QUOTA_EXCEEDED'
  | 'HOST_DAY_LIMIT'
  // evaluateEntry deny codes (HOST_NOT_VERIFIED/HOST_SUSPENDED/VISITOR_BANNED reused above)
  | 'VISIT_NOT_APPROVED'
  | 'AFTER_HARD_CUTOFF'
  | 'AFTER_ENTRY_CUTOFF'
  | 'TOO_EARLY'
  | 'WINDOW_ENDED'
  | 'ALREADY_INSIDE'
  // flag-only codes (evaluateEntry steps 9-10, evaluateExit)
  | 'LOCATION_UNVERIFIED'
  | 'LATE_EXIT';

export interface RuleResult {
  decision: Decision;
  /** Every reason, deny codes first. For a 'deny' result this is exactly one code
   * (SDD §4.5: "Deny codes stop evaluation and are returned immediately"). For
   * 'allow'/'allow_flagged' this is zero or more flag codes, in check order. */
  codes: RuleCode[];
  /** Only set by evaluateCreate (BR-07); omitted by evaluateEntry/evaluateExit. */
  zone?: Zone;
}

function denyResult(code: RuleCode): RuleResult {
  return { decision: 'deny', codes: [code] };
}

function flaggedResult(codes: RuleCode[], zone?: Zone): RuleResult {
  const result: RuleResult = { decision: codes.length > 0 ? 'allow_flagged' : 'allow', codes };
  if (zone) result.zone = zone;
  return result;
}

// Exported for the evaluate-*.ts modules; not part of the public API surface (not
// re-exported from index.ts) — just shared construction helpers so each evaluator
// doesn't repeat the same decision/codes bookkeeping.
export const RuleResultBuilders = { denyResult, flaggedResult };

/**
 * Host status and suspension are re-checked by both evaluateCreate and evaluateEntry
 * (SDD §4.5) — pulled into one shape both contexts embed, rather than repeating the
 * two fields in each.
 */
export interface HostState {
  status: 'pending' | 'verified' | 'rejected' | 'suspended' | 'left';
  /** `residents.hosting_suspended_until` — null means not currently suspended. */
  suspendedUntil: Date | null;
}

/**
 * One existing active overnight_room booking for this host, used for the BR-06
 * overlap check and the BR-05 monthly quota (via `nightsBetween`/`quotaUsed`). The
 * caller supplies only *active* bookings (status `approved` or `inside`) — a
 * cancelled/rejected/expired one must not count, and evaluateCreate has no status
 * enum to filter on since it only sees what the API chose to pass in.
 */
export interface ExistingOvernightBooking {
  arrivalDate: string; // YYYY-MM-DD, hostel-local
  departureDate: string; // YYYY-MM-DD, hostel-local
}

export interface CreateContext {
  now: Date;
  type: import('./config.js').VisitType;
  hostelGender: import('./config.js').HostelGender;
  host: HostState;
  /** Active ban on the visitor, if the visitor is already known (SDD §4.5 step 3:
   * "active ban on visitor (if known)"). A brand-new invited phone with no visitor
   * row yet has nothing to check — pass `false`, not an error. */
  visitorBanned: boolean;
  /** Null when not yet known (SDD §12.6: gender is optional for invites, required
   * for overnight). Treated the same as 'undisclosed' for zone/type purposes — see
   * `zone.ts` — a documented, conservative default, not an SDD-literal value. */
  guestGender: Gender | null;
  windowStart: Date;
  windowEnd: Date;
  /** Only meaningful for overnight_room/guest_room; required by nightsBetween/the
   * quota and overlap checks when `type` is one of those two. */
  arrivalDate?: string;
  departureDate?: string;
  /** Only relevant for overnight_room (BR-05/BR-06); empty array otherwise. */
  existingOvernightBookings: ExistingOvernightBooking[];
  /** Count of this host's day/quick_drop guests currently `inside`, anywhere (BR-11). */
  hostActiveDayGuestCount: number;
}

export interface EntryContext {
  now: Date;
  type: import('./config.js').VisitType;
  host: HostState;
  visitorBanned: boolean;
  /** The visit's current status at the moment of this entry attempt. */
  visitStatus:
    | 'pending_host'
    | 'pending_warden'
    | 'approved'
    | 'inside'
    | 'completed'
    | 'rejected'
    | 'expired'
    | 'cancelled';
  windowStart: Date;
  windowEnd: Date;
  /** True if this visitor is currently `inside` on a *different* visit (BR-15). */
  visitorAlreadyInsideElsewhere: boolean;
  /** False means the GPS check failed and the host confirmed presence instead (SDD
   * §9.3 F3) — by the time evaluateEntry is called, that confirmation has already
   * happened; the engine only needs to know whether to raise the flag. */
  gpsOk: boolean;
  /** Count of this host's day/quick_drop guests `inside`, anywhere, at the moment of
   * entry (may have grown since approval) — SDD §4.5 step 10, flag only. */
  hostActiveDayGuestCount: number;
}

export interface ExitContext {
  now: Date;
  windowEnd: Date;
  gpsOk: boolean;
}
