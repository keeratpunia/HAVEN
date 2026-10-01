import { describe, expect, it } from 'vitest';
import { GH8_RULES_CONFIG_V1 } from './config.js';
import { evaluateCreate } from './evaluate-create.js';
import { localDateTimeToUtc } from './time.js';
import type { CreateContext, ExistingOvernightBooking } from './types.js';

const cfg = GH8_RULES_CONFIG_V1;
const TZ = cfg.timezone;

const NOW = new Date('2026-10-12T10:00:00+05:30'); // Monday, well inside visiting hours

function overnightWindow(arrivalDate: string, departureDate: string) {
  return {
    windowStart: localDateTimeToUtc(arrivalDate, cfg.visiting_start, TZ),
    windowEnd: localDateTimeToUtc(departureDate, cfg.overnight_checkout_time, TZ),
  };
}

function baseCreateContext(overrides: Partial<CreateContext> = {}): CreateContext {
  return {
    now: NOW,
    type: 'day',
    hostelGender: 'female',
    host: { status: 'verified', suspendedUntil: null },
    visitorBanned: false,
    guestGender: 'female',
    windowStart: new Date('2026-10-12T15:00:00+05:30'),
    windowEnd: new Date('2026-10-12T21:00:00+05:30'),
    existingOvernightBookings: [],
    hostActiveDayGuestCount: 0,
    ...overrides,
  };
}

describe('evaluateCreate — SDD §4.6 worked examples', () => {
  it('male guest, day invite, GH-8 → allow, zone visitors_room', () => {
    const result = evaluateCreate(baseCreateContext({ guestGender: 'male' }), cfg);
    expect(result).toEqual({ decision: 'allow', codes: [], zone: 'visitors_room' });
  });

  it('male guest, overnight request, GH-8 → deny TYPE_NOT_ALLOWED_FOR_GENDER', () => {
    const { windowStart, windowEnd } = overnightWindow('2026-10-20', '2026-10-22');
    const result = evaluateCreate(
      baseCreateContext({
        type: 'overnight_room',
        guestGender: 'male',
        windowStart,
        windowEnd,
        arrivalDate: '2026-10-20',
        departureDate: '2026-10-22',
      }),
      cfg,
    );
    expect(result).toEqual({ decision: 'deny', codes: ['TYPE_NOT_ALLOWED_FOR_GENDER'] });
  });

  it('4th night in October (host already has 3) → deny QUOTA_EXCEEDED', () => {
    // Existing nights are historical (before NOW) — fine, only the *new* request's
    // own window is subject to WINDOW_INVALID's "not in the past" check.
    const existing: ExistingOvernightBooking[] = [
      { arrivalDate: '2026-10-01', departureDate: '2026-10-04' },
    ]; // 3 nights: 1,2,3 Oct
    const { windowStart, windowEnd } = overnightWindow('2026-10-25', '2026-10-26'); // 1 more Oct night, in the future relative to NOW (12 Oct)
    const result = evaluateCreate(
      baseCreateContext({
        type: 'overnight_room',
        windowStart,
        windowEnd,
        arrivalDate: '2026-10-25',
        departureDate: '2026-10-26',
        existingOvernightBookings: existing,
      }),
      cfg,
    );
    expect(result).toEqual({ decision: 'deny', codes: ['QUOTA_EXCEEDED'] });
  });

  it('31 Oct → 2 Nov with 3 existing Oct nights → deny (Oct would be 4)', () => {
    const existing: ExistingOvernightBooking[] = [
      { arrivalDate: '2026-10-01', departureDate: '2026-10-04' },
    ]; // 1,2,3 Oct
    const { windowStart, windowEnd } = overnightWindow('2026-10-31', '2026-11-02'); // nights 31 Oct, 1 Nov
    const result = evaluateCreate(
      baseCreateContext({
        type: 'overnight_room',
        windowStart,
        windowEnd,
        arrivalDate: '2026-10-31',
        departureDate: '2026-11-02',
        existingOvernightBookings: existing,
      }),
      cfg,
    );
    expect(result.decision).toBe('deny');
    expect(result.codes).toContain('QUOTA_EXCEEDED');
  });

  it('30 Oct → 1 Nov with 1 existing Oct night → allow (Oct total = 3)', () => {
    const existing: ExistingOvernightBooking[] = [
      { arrivalDate: '2026-10-05', departureDate: '2026-10-06' },
    ]; // 1 night: 5 Oct
    const { windowStart, windowEnd } = overnightWindow('2026-10-30', '2026-11-01'); // nights 30, 31 Oct
    const result = evaluateCreate(
      baseCreateContext({
        type: 'overnight_room',
        windowStart,
        windowEnd,
        arrivalDate: '2026-10-30',
        departureDate: '2026-11-01',
        existingOvernightBookings: existing,
      }),
      cfg,
    );
    expect(result.decision).toBe('allow');
    expect(result.zone).toBe('room');
  });
});

describe('evaluateCreate — TC-RULE-12..15', () => {
  it('TC-RULE-12: undisclosed gender, day invite to GH-8 → allow, zone visitors_room', () => {
    const result = evaluateCreate(baseCreateContext({ guestGender: 'undisclosed' }), cfg);
    expect(result).toEqual({ decision: 'allow', codes: [], zone: 'visitors_room' });
  });

  it('TC-RULE-13: host status pending creates invite → deny HOST_NOT_VERIFIED', () => {
    const result = evaluateCreate(
      baseCreateContext({ host: { status: 'pending', suspendedUntil: null } }),
      cfg,
    );
    expect(result).toEqual({ decision: 'deny', codes: ['HOST_NOT_VERIFIED'] });
  });

  it('TC-RULE-14: suspended host until yesterday → allow (suspension expired)', () => {
    const yesterday = new Date('2026-10-11T10:00:00+05:30');
    const result = evaluateCreate(
      baseCreateContext({ host: { status: 'verified', suspendedUntil: yesterday } }),
      cfg,
    );
    expect(result.decision).toBe('allow');
  });

  it('TC-RULE-15: overnight overlap with an existing approved overnight → deny OVERNIGHT_OVERLAP', () => {
    const existing: ExistingOvernightBooking[] = [
      { arrivalDate: '2026-10-20', departureDate: '2026-10-25' },
    ];
    const { windowStart, windowEnd } = overnightWindow('2026-10-22', '2026-10-24'); // fully inside existing stay
    const result = evaluateCreate(
      baseCreateContext({
        type: 'overnight_room',
        windowStart,
        windowEnd,
        arrivalDate: '2026-10-22',
        departureDate: '2026-10-24',
        existingOvernightBookings: existing,
      }),
      cfg,
    );
    expect(result).toEqual({ decision: 'deny', codes: ['OVERNIGHT_OVERLAP'] });
  });
});

describe('evaluateCreate — HOST_NOT_VERIFIED (step 1)', () => {
  for (const status of ['pending', 'rejected', 'suspended', 'left'] as const) {
    it(`denies when host status is "${status}"`, () => {
      const result = evaluateCreate(
        baseCreateContext({ host: { status, suspendedUntil: null } }),
        cfg,
      );
      expect(result).toEqual({ decision: 'deny', codes: ['HOST_NOT_VERIFIED'] });
    });
  }
});

describe('evaluateCreate — HOST_SUSPENDED (step 2)', () => {
  it('denies when suspendedUntil is in the future', () => {
    const future = new Date('2026-12-01T00:00:00+05:30');
    const result = evaluateCreate(
      baseCreateContext({ host: { status: 'verified', suspendedUntil: future } }),
      cfg,
    );
    expect(result).toEqual({ decision: 'deny', codes: ['HOST_SUSPENDED'] });
  });

  it('exactly at the suspension boundary (suspendedUntil === now) is treated as still suspended (strict > , not >=, means equal is NOT suspended)', () => {
    // suspendedUntil > now is the deny condition; equal is false, so equal-to-now is NOT denied.
    const result = evaluateCreate(
      baseCreateContext({ host: { status: 'verified', suspendedUntil: NOW } }),
      cfg,
    );
    expect(result.decision).not.toBe('deny');
  });

  it('one millisecond before suspendedUntil denies', () => {
    const justBefore = new Date(NOW.getTime() - 1);
    const result = evaluateCreate(
      baseCreateContext({ now: justBefore, host: { status: 'verified', suspendedUntil: NOW } }),
      cfg,
    );
    expect(result).toEqual({ decision: 'deny', codes: ['HOST_SUSPENDED'] });
  });
});

describe('evaluateCreate — VISITOR_BANNED (step 3)', () => {
  it('denies when the visitor has an active ban', () => {
    const result = evaluateCreate(baseCreateContext({ visitorBanned: true }), cfg);
    expect(result).toEqual({ decision: 'deny', codes: ['VISITOR_BANNED'] });
  });
});

describe('evaluateCreate — TYPE_NOT_ALLOWED_FOR_GENDER (step 4)', () => {
  it('denies guest_room for opposite gender', () => {
    const { windowStart, windowEnd } = overnightWindow('2026-10-20', '2026-10-21');
    const result = evaluateCreate(
      baseCreateContext({
        type: 'guest_room',
        guestGender: 'male',
        windowStart,
        windowEnd,
        arrivalDate: '2026-10-20',
        departureDate: '2026-10-21',
      }),
      cfg,
    );
    expect(result).toEqual({ decision: 'deny', codes: ['TYPE_NOT_ALLOWED_FOR_GENDER'] });
  });

  it('denies overnight_room for undisclosed gender', () => {
    const { windowStart, windowEnd } = overnightWindow('2026-10-20', '2026-10-21');
    const result = evaluateCreate(
      baseCreateContext({
        type: 'overnight_room',
        guestGender: 'undisclosed',
        windowStart,
        windowEnd,
        arrivalDate: '2026-10-20',
        departureDate: '2026-10-21',
      }),
      cfg,
    );
    expect(result).toEqual({ decision: 'deny', codes: ['TYPE_NOT_ALLOWED_FOR_GENDER'] });
  });

  it('does NOT deny day type for opposite gender (zoned instead, not refused)', () => {
    const result = evaluateCreate(baseCreateContext({ type: 'day', guestGender: 'male' }), cfg);
    expect(result.decision).toBe('allow');
  });

  it('allows overnight_room for same-gender guest', () => {
    const { windowStart, windowEnd } = overnightWindow('2026-10-20', '2026-10-21');
    const result = evaluateCreate(
      baseCreateContext({
        type: 'overnight_room',
        guestGender: 'female',
        windowStart,
        windowEnd,
        arrivalDate: '2026-10-20',
        departureDate: '2026-10-21',
      }),
      cfg,
    );
    expect(result.decision).toBe('allow');
    expect(result.zone).toBe('room');
  });
});

describe('evaluateCreate — WINDOW_INVALID (step 5)', () => {
  it('denies when windowEnd equals windowStart', () => {
    const t = new Date('2026-10-12T15:00:00+05:30');
    const result = evaluateCreate(baseCreateContext({ windowStart: t, windowEnd: t }), cfg);
    expect(result).toEqual({ decision: 'deny', codes: ['WINDOW_INVALID'] });
  });

  it('denies when windowEnd is before windowStart', () => {
    const result = evaluateCreate(
      baseCreateContext({
        windowStart: new Date('2026-10-12T15:00:00+05:30'),
        windowEnd: new Date('2026-10-12T14:00:00+05:30'),
      }),
      cfg,
    );
    expect(result).toEqual({ decision: 'deny', codes: ['WINDOW_INVALID'] });
  });

  it('denies a day window that crosses midnight (different local dates)', () => {
    const result = evaluateCreate(
      baseCreateContext({
        windowStart: new Date('2026-10-12T21:00:00+05:30'),
        windowEnd: new Date('2026-10-13T01:00:00+05:30'),
      }),
      cfg,
    );
    expect(result).toEqual({ decision: 'deny', codes: ['WINDOW_INVALID'] });
  });

  it('denies a day window starting before visiting_start (08:00)', () => {
    const result = evaluateCreate(
      baseCreateContext({
        windowStart: new Date('2026-10-12T07:59:00+05:30'),
        windowEnd: new Date('2026-10-12T21:00:00+05:30'),
      }),
      cfg,
    );
    expect(result).toEqual({ decision: 'deny', codes: ['WINDOW_INVALID'] });
  });

  it('allows a day window starting exactly at visiting_start (08:00)', () => {
    const result = evaluateCreate(
      baseCreateContext({
        windowStart: new Date('2026-10-12T08:00:00+05:30'),
        windowEnd: new Date('2026-10-12T21:00:00+05:30'),
      }),
      cfg,
    );
    expect(result.decision).toBe('allow');
  });

  it('denies a day window ending after day_visit_latest_end (22:00)', () => {
    const result = evaluateCreate(
      baseCreateContext({
        windowStart: new Date('2026-10-12T15:00:00+05:30'),
        windowEnd: new Date('2026-10-12T22:00:01+05:30'),
      }),
      cfg,
    );
    expect(result).toEqual({ decision: 'deny', codes: ['WINDOW_INVALID'] });
  });

  it('allows a day window ending exactly at day_visit_latest_end (22:00)', () => {
    const result = evaluateCreate(
      baseCreateContext({
        windowStart: new Date('2026-10-12T15:00:00+05:30'),
        windowEnd: new Date('2026-10-12T22:00:00+05:30'),
      }),
      cfg,
    );
    expect(result.decision).toBe('allow');
  });

  it('denies a window that has already fully elapsed (windowEnd <= now)', () => {
    const result = evaluateCreate(
      baseCreateContext({
        now: new Date('2026-10-12T21:00:01+05:30'),
        windowStart: new Date('2026-10-12T15:00:00+05:30'),
        windowEnd: new Date('2026-10-12T21:00:00+05:30'),
      }),
      cfg,
    );
    expect(result).toEqual({ decision: 'deny', codes: ['WINDOW_INVALID'] });
  });
});

describe('evaluateCreate — TOO_FAR_AHEAD (step 6)', () => {
  it('allows an invite exactly invite_max_days_ahead (7 days) in advance', () => {
    const result = evaluateCreate(
      baseCreateContext({
        windowStart: new Date('2026-10-19T15:00:00+05:30'), // NOW + 7 days
        windowEnd: new Date('2026-10-19T21:00:00+05:30'),
      }),
      cfg,
    );
    expect(result.decision).toBe('allow');
  });

  it('denies an invite 8 days in advance (one past invite_max_days_ahead)', () => {
    const result = evaluateCreate(
      baseCreateContext({
        windowStart: new Date('2026-10-20T15:00:00+05:30'), // NOW + 8 days
        windowEnd: new Date('2026-10-20T21:00:00+05:30'),
      }),
      cfg,
    );
    expect(result).toEqual({ decision: 'deny', codes: ['TOO_FAR_AHEAD'] });
  });

  it('allows an overnight request exactly overnight_max_days_ahead (30 days) in advance', () => {
    const arrival = '2026-11-11'; // NOW (12 Oct) + 30 days
    const departure = '2026-11-12';
    const { windowStart, windowEnd } = overnightWindow(arrival, departure);
    const result = evaluateCreate(
      baseCreateContext({
        type: 'overnight_room',
        windowStart,
        windowEnd,
        arrivalDate: arrival,
        departureDate: departure,
      }),
      cfg,
    );
    expect(result.decision).toBe('allow');
  });

  it('denies an overnight request 31 days ahead (one past overnight_max_days_ahead)', () => {
    const arrival = '2026-11-12'; // NOW (12 Oct) + 31 days
    const departure = '2026-11-13';
    const { windowStart, windowEnd } = overnightWindow(arrival, departure);
    const result = evaluateCreate(
      baseCreateContext({
        type: 'overnight_room',
        windowStart,
        windowEnd,
        arrivalDate: arrival,
        departureDate: departure,
      }),
      cfg,
    );
    expect(result).toEqual({ decision: 'deny', codes: ['TOO_FAR_AHEAD'] });
  });
});

describe('evaluateCreate — OVERNIGHT_OVERLAP boundaries (step 7)', () => {
  it('allows back-to-back stays that touch but do not share a night (departure day = next arrival day)', () => {
    const existing: ExistingOvernightBooking[] = [
      { arrivalDate: '2026-10-20', departureDate: '2026-11-01' },
    ]; // nights up to 31 Oct
    const { windowStart, windowEnd } = overnightWindow('2026-11-01', '2026-11-03'); // starts 1 Nov — no shared night
    const result = evaluateCreate(
      baseCreateContext({
        type: 'overnight_room',
        windowStart,
        windowEnd,
        arrivalDate: '2026-11-01',
        departureDate: '2026-11-03',
        existingOvernightBookings: existing,
      }),
      cfg,
    );
    expect(result.decision).toBe('allow');
  });

  it('denies when exactly one night is shared', () => {
    const existing: ExistingOvernightBooking[] = [
      { arrivalDate: '2026-10-20', departureDate: '2026-10-22' },
    ]; // nights 20, 21 Oct
    const { windowStart, windowEnd } = overnightWindow('2026-10-21', '2026-10-23'); // nights 21, 22 Oct — shares 21 Oct
    const result = evaluateCreate(
      baseCreateContext({
        type: 'overnight_room',
        windowStart,
        windowEnd,
        arrivalDate: '2026-10-21',
        departureDate: '2026-10-23',
        existingOvernightBookings: existing,
      }),
      cfg,
    );
    expect(result).toEqual({ decision: 'deny', codes: ['OVERNIGHT_OVERLAP'] });
  });

  it('OVERNIGHT_OVERLAP does not apply to guest_room (BR-06 is "overnight in room" only)', () => {
    const { windowStart, windowEnd } = overnightWindow('2026-10-21', '2026-10-23');
    const result = evaluateCreate(
      baseCreateContext({
        type: 'guest_room',
        windowStart,
        windowEnd,
        arrivalDate: '2026-10-21',
        departureDate: '2026-10-23',
        // existingOvernightBookings is about overnight_room; guest_room ignores it entirely
        existingOvernightBookings: [{ arrivalDate: '2026-10-20', departureDate: '2026-10-25' }],
      }),
      cfg,
    );
    expect(result.decision).toBe('allow');
    expect(result.zone).toBe('guest_room');
  });
});

describe('evaluateCreate — QUOTA_EXCEEDED does not apply to guest_room', () => {
  it('allows a guest_room booking even with many existing overnight_room nights that month', () => {
    const existing: ExistingOvernightBooking[] = [
      { arrivalDate: '2026-10-01', departureDate: '2026-10-10' },
    ]; // 9 nights, already over max 3
    const { windowStart, windowEnd } = overnightWindow('2026-10-20', '2026-10-21');
    const result = evaluateCreate(
      baseCreateContext({
        type: 'guest_room',
        windowStart,
        windowEnd,
        arrivalDate: '2026-10-20',
        departureDate: '2026-10-21',
        existingOvernightBookings: existing,
      }),
      cfg,
    );
    expect(result.decision).toBe('allow');
  });
});

describe('evaluateCreate — HOST_DAY_LIMIT (step 9)', () => {
  it('allows when active day guests is one below the max', () => {
    const result = evaluateCreate(baseCreateContext({ hostActiveDayGuestCount: 2 }), cfg); // max is 3
    expect(result.decision).toBe('allow');
  });

  it('denies exactly at the max (3)', () => {
    const result = evaluateCreate(baseCreateContext({ hostActiveDayGuestCount: 3 }), cfg);
    expect(result).toEqual({ decision: 'deny', codes: ['HOST_DAY_LIMIT'] });
  });

  it('denies above the max', () => {
    const result = evaluateCreate(baseCreateContext({ hostActiveDayGuestCount: 5 }), cfg);
    expect(result).toEqual({ decision: 'deny', codes: ['HOST_DAY_LIMIT'] });
  });

  it('does NOT deny a future-dated day invite even if today\'s count is already at the max (SDD §4.5: "deny for walk-ins and same-day invites")', () => {
    const result = evaluateCreate(
      baseCreateContext({
        windowStart: new Date('2026-10-13T15:00:00+05:30'), // tomorrow, not today
        windowEnd: new Date('2026-10-13T21:00:00+05:30'),
        hostActiveDayGuestCount: 10,
      }),
      cfg,
    );
    expect(result.decision).toBe('allow');
  });

  it('does not apply to overnight_room/guest_room at all', () => {
    const { windowStart, windowEnd } = overnightWindow('2026-10-20', '2026-10-21');
    const result = evaluateCreate(
      baseCreateContext({
        type: 'overnight_room',
        windowStart,
        windowEnd,
        arrivalDate: '2026-10-20',
        departureDate: '2026-10-21',
        hostActiveDayGuestCount: 999,
      }),
      cfg,
    );
    expect(result.decision).toBe('allow');
  });
});

describe('evaluateCreate — evaluation order (deny codes stop immediately, SDD §4.5)', () => {
  it('reports only HOST_NOT_VERIFIED when both the host is unverified AND the visitor is banned', () => {
    const result = evaluateCreate(
      baseCreateContext({ host: { status: 'pending', suspendedUntil: null }, visitorBanned: true }),
      cfg,
    );
    expect(result.codes).toEqual(['HOST_NOT_VERIFIED']);
    expect(result.codes).not.toContain('VISITOR_BANNED');
  });

  it('reports only VISITOR_BANNED when the host is suspended AND the visitor is banned (banned checked after suspension)', () => {
    const future = new Date('2026-12-01T00:00:00+05:30');
    const result = evaluateCreate(
      baseCreateContext({
        host: { status: 'verified', suspendedUntil: future },
        visitorBanned: true,
      }),
      cfg,
    );
    expect(result.codes).toEqual(['HOST_SUSPENDED']);
  });
});

describe('evaluateCreate — quick_drop zoning and gender independence', () => {
  it('quick_drop is allowed and zoned "gate" for an opposite-gender guest too', () => {
    const result = evaluateCreate(
      baseCreateContext({ type: 'quick_drop', guestGender: 'male' }),
      cfg,
    );
    expect(result).toEqual({ decision: 'allow', codes: [], zone: 'gate' });
  });
});
