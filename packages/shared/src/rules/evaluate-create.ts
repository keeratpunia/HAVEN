import type { RulesConfig } from './config.js';
import { monthsTouched, nightsBetween, quotaUsed } from './nights.js';
import {
  daysBetween,
  isLocalTimeAtOrAfter,
  isLocalTimeAtOrBefore,
  isSameLocalDate,
  toLocalDateString,
} from './time.js';
import type { CreateContext, RuleResult } from './types.js';
import { RuleResultBuilders } from './types.js';
import { computeZone, isOppositeGender } from './zone.js';

const { denyResult, flaggedResult } = RuleResultBuilders;

/**
 * SDD §4.4/§4.5: `evaluateCreate` — pre-invite, walk-in request, overnight request.
 * Each check appends a code; deny codes stop evaluation and return immediately, flag
 * codes accumulate. Order matches SDD §4.5 exactly; do not reorder without updating
 * the SDD in the same change (CLAUDE.md §1.3).
 */
export function evaluateCreate(ctx: CreateContext, cfg: RulesConfig): RuleResult {
  // 1. HOST_NOT_VERIFIED
  if (ctx.host.status !== 'verified') {
    return denyResult('HOST_NOT_VERIFIED');
  }

  // 2. HOST_SUSPENDED
  if (ctx.host.suspendedUntil !== null && ctx.host.suspendedUntil > ctx.now) {
    return denyResult('HOST_SUSPENDED');
  }

  // 3. VISITOR_BANNED
  if (ctx.visitorBanned) {
    return denyResult('VISITOR_BANNED');
  }

  // 4. TYPE_NOT_ALLOWED_FOR_GENDER — overnight types with opposite/undisclosed gender
  const isOvernightType = ctx.type === 'overnight_room' || ctx.type === 'guest_room';
  if (isOvernightType && isOppositeGender(ctx.guestGender, cfg.hostel_gender)) {
    return denyResult('TYPE_NOT_ALLOWED_FOR_GENDER');
  }

  // 5. WINDOW_INVALID — end <= start, crosses dates (day/quick_drop), outside
  // visiting hours (day/quick_drop only), or in the past.
  if (ctx.windowEnd <= ctx.windowStart) {
    return denyResult('WINDOW_INVALID');
  }
  if (ctx.windowEnd <= ctx.now) {
    return denyResult('WINDOW_INVALID');
  }
  const isDayType = ctx.type === 'day' || ctx.type === 'quick_drop';
  if (isDayType) {
    if (!isSameLocalDate(ctx.windowStart, ctx.windowEnd, cfg.timezone)) {
      return denyResult('WINDOW_INVALID');
    }
    if (!isLocalTimeAtOrAfter(ctx.windowStart, cfg.visiting_start, cfg.timezone)) {
      return denyResult('WINDOW_INVALID');
    }
    if (!isLocalTimeAtOrBefore(ctx.windowEnd, cfg.day_visit_latest_end, cfg.timezone)) {
      return denyResult('WINDOW_INVALID');
    }
  }

  // 6. TOO_FAR_AHEAD — beyond invite_max_days_ahead / overnight_max_days_ahead
  const today = toLocalDateString(ctx.now, cfg.timezone);
  if (isDayType) {
    const startDate = toLocalDateString(ctx.windowStart, cfg.timezone);
    if (daysBetween(today, startDate, cfg.timezone) > cfg.invite_max_days_ahead) {
      return denyResult('TOO_FAR_AHEAD');
    }
  } else if (
    ctx.arrivalDate &&
    daysBetween(today, ctx.arrivalDate, cfg.timezone) > cfg.overnight_max_days_ahead
  ) {
    return denyResult('TOO_FAR_AHEAD');
  }

  // 7. OVERNIGHT_OVERLAP — overnight_room only (BR-06: "at most one overnight guest
  // per host at a time", config max_concurrent generalises "one"). Existing bookings
  // are assumed already mutually non-overlapping (the same rule enforced them);
  // count how many overlap the *new* request and deny if admitting it would push the
  // concurrent count past max_concurrent.
  if (ctx.type === 'overnight_room' && ctx.arrivalDate && ctx.departureDate) {
    const newNights = new Set(nightsBetween(ctx.arrivalDate, ctx.departureDate));
    const overlappingCount = ctx.existingOvernightBookings.filter((booking) => {
      const existingNights = nightsBetween(booking.arrivalDate, booking.departureDate);
      return existingNights.some((night) => newNights.has(night));
    }).length;
    if (overlappingCount + 1 > cfg.overnight_room.max_concurrent) {
      return denyResult('OVERNIGHT_OVERLAP');
    }
  }

  // 8. QUOTA_EXCEEDED — overnight_room only (BR-05): any touched month's used +
  // requested nights > max_nights_per_month.
  if (ctx.type === 'overnight_room' && ctx.arrivalDate && ctx.departureDate) {
    const newNights = nightsBetween(ctx.arrivalDate, ctx.departureDate);
    const existingNights = ctx.existingOvernightBookings.flatMap((booking) =>
      nightsBetween(booking.arrivalDate, booking.departureDate),
    );
    for (const month of monthsTouched(newNights)) {
      const used = quotaUsed(existingNights, month);
      const requested = quotaUsed(newNights, month);
      if (used + requested > cfg.overnight_room.max_nights_per_month) {
        return denyResult('QUOTA_EXCEEDED');
      }
    }
  }

  // 9. HOST_DAY_LIMIT — day/quick_drop only, and only when the window starts today
  // (SDD §4.5: "deny for walk-ins and same-day invites" — a future-dated day invite
  // isn't blocked by today's current occupancy).
  if (isDayType && isSameLocalDate(ctx.windowStart, ctx.now, cfg.timezone)) {
    if (ctx.hostActiveDayGuestCount >= cfg.max_active_day_guests) {
      return denyResult('HOST_DAY_LIMIT');
    }
  }

  // 10. Zone computed (BR-07) and returned — no flag codes apply to evaluateCreate,
  // so this is always a plain 'allow'.
  const zone = computeZone(ctx.type, ctx.guestGender, cfg.hostel_gender, cfg);
  return flaggedResult([], zone);
}
