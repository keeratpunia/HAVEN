import type { Gender, HostelGender, VisitType, Zone } from './config.js';
import type { RulesConfig } from './config.js';

/**
 * BR-07: "Guests whose gender differs from the hostel's get zone visitors_room and
 * cannot be booked for overnight_room or guest_room. Guests who choose 'Prefer not to
 * say' are treated the same way." (config: `undisclosed_gender_as_opposite: true`).
 *
 * `guestGender: null` (gender not yet known — SDD §12.6, optional at invite creation)
 * is treated the same as 'undisclosed': the more restrictive, conservative default.
 * This is a documented interpretation, not an SDD-literal value — see
 * `docs/DECISIONS.md`. The SDD's own resolution for the real case (gender becomes
 * known) is explicit: "zone is recomputed when the invite is claimed" — i.e. the API
 * calls evaluateCreate again once `guestGender` is known, superseding this default.
 */
export function isOppositeGender(guestGender: Gender | null, hostelGender: HostelGender): boolean {
  if (guestGender === null) return true;
  if (guestGender === 'undisclosed') return true;
  return guestGender !== hostelGender;
}

/**
 * BR-07 + the visit-type table (SDD §4.1): quick_drop is always zoned 'gate'
 * (fixed 15-minute gate-only visit); day is 'room' for same-gender guests,
 * 'visitors_room' otherwise; overnight_room/guest_room are only reachable for
 * same-gender guests (opposite/undisclosed is denied earlier, TYPE_NOT_ALLOWED_FOR_GENDER)
 * so they always zone to 'room'/'guest_room' respectively.
 */
export function computeZone(
  type: VisitType,
  guestGender: Gender | null,
  hostelGender: HostelGender,
  cfg: RulesConfig,
): Zone {
  if (type === 'quick_drop') return 'gate';
  if (type === 'guest_room') return 'guest_room';
  if (type === 'overnight_room') return 'room'; // only reached when not opposite-gender
  // type === 'day' — "Rules are data, not code" (CLAUDE.md §3.3): the opposite-gender
  // zone comes from config, not a hardcoded 'visitors_room' literal.
  return isOppositeGender(guestGender, hostelGender) ? cfg.opposite_gender.zone : 'room';
}
