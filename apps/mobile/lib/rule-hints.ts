import {
  evaluateCreate,
  formatTime12h,
  GH8_RULES_CONFIG_V1,
  localDateTimeToUtc,
  type RuleCode,
  type RulesConfig,
} from '@haven/shared';

/**
 * Instant form feedback for R-06/R-11 (SDD §14: "inline validation from the shared Zod
 * schema, rule hints under time fields ('Entry closes at 8:00 pm')"). This runs the
 * same `evaluateCreate` the API runs, but only as a hint: the client doesn't know the
 * host's live state (suspension, guests inside, quota), so it assumes a verified host
 * with nothing in flight and never decides on its own — `POST /visits/preview` and the
 * create call do (CLAUDE.md §3.3).
 */

export const RULES: RulesConfig = GH8_RULES_CONFIG_V1;

function at(time: string): string {
  return formatTime12h(localDateTimeToUtc('2026-01-01', time, RULES.timezone));
}

/** Rule hints shown under the time fields. */
export function dayVisitHints(): string[] {
  return [
    `Visits run ${at(RULES.visiting_start)} – ${at(RULES.day_visit_latest_end)}, on one day.`,
    `Entry closes at ${at(RULES.last_entry_day)}.`,
    `Invites can be made up to ${RULES.invite_max_days_ahead} days ahead.`,
  ];
}

export function overnightHints(): string[] {
  return [
    `Guests can arrive from ${at(RULES.visiting_start)} until ${at(RULES.hard_cutoff)} and check out by ${at(RULES.overnight_checkout_time)}.`,
    `Up to ${RULES.overnight_room.max_nights_per_month} nights in your room per month · ₹${RULES.overnight_room.charge_per_night_inr} a night; guest room ₹${RULES.guest_room.charge_per_night_inr} a night.`,
    `Requests can be made up to ${RULES.overnight_max_days_ahead} days ahead.`,
  ];
}

/** Plain-English sentence for a rules-engine code (SDD §13.1 principle 3). */
export function ruleMessage(code: RuleCode | string): string {
  switch (code) {
    case 'HOST_NOT_VERIFIED':
      return 'You can invite guests once the warden verifies you.';
    case 'HOST_SUSPENDED':
      return 'Your guest privileges are suspended.';
    case 'VISITOR_BANNED':
      return "This guest can't enter this hostel.";
    case 'TYPE_NOT_ALLOWED_FOR_GENDER':
      return 'Hostel rules allow this guest only in the Visitors’ Room, so they can’t stay overnight.';
    case 'WINDOW_INVALID':
      return `Pick a time between ${at(RULES.visiting_start)} and ${at(RULES.day_visit_latest_end)} on one day, ending after it starts and not in the past.`;
    case 'TOO_FAR_AHEAD':
      return 'That date is too far ahead.';
    case 'OVERNIGHT_OVERLAP':
      return 'You already have an overnight guest on those nights.';
    case 'QUOTA_EXCEEDED':
      return `That would go over ${RULES.overnight_room.max_nights_per_month} nights in a month.`;
    case 'HOST_DAY_LIMIT':
      return `You already have ${RULES.max_active_day_guests} guests inside.`;
    default:
      return 'This visit isn’t allowed by the hostel rules.';
  }
}

/** Local, optimistic `evaluateCreate` for a day/quick drop-off invite window. */
export function localInviteCheck(p: {
  type: 'day' | 'quick_drop';
  windowStart: Date;
  windowEnd: Date;
  now: Date;
}): RuleCode | null {
  const result = evaluateCreate(
    {
      now: p.now,
      type: p.type,
      hostelGender: RULES.hostel_gender,
      host: { status: 'verified', suspendedUntil: null },
      visitorBanned: false,
      guestGender: null,
      windowStart: p.windowStart,
      windowEnd: p.windowEnd,
      existingOvernightBookings: [],
      hostActiveDayGuestCount: 0,
    },
    RULES,
  );
  return result.decision === 'deny' ? (result.codes[0] ?? null) : null;
}
