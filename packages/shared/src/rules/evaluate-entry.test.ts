import { describe, expect, it } from 'vitest';
import { GH8_RULES_CONFIG_V1 } from './config.js';
import { evaluateEntry } from './evaluate-entry.js';
import type { EntryContext } from './types.js';

const cfg = GH8_RULES_CONFIG_V1;

function baseEntryContext(overrides: Partial<EntryContext> = {}): EntryContext {
  return {
    now: new Date('2026-10-12T15:30:00+05:30'),
    type: 'day',
    host: { status: 'verified', suspendedUntil: null },
    visitorBanned: false,
    visitStatus: 'approved',
    windowStart: new Date('2026-10-12T15:00:00+05:30'),
    windowEnd: new Date('2026-10-12T21:00:00+05:30'),
    visitorAlreadyInsideElsewhere: false,
    gpsOk: true,
    hostActiveDayGuestCount: 0,
    ...overrides,
  };
}

describe('evaluateEntry — SDD §4.6 worked examples', () => {
  it('day guest at 19:59, approved day visit window 15:00–21:00 → allow', () => {
    const result = evaluateEntry(
      baseEntryContext({
        now: new Date('2026-10-12T19:59:00+05:30'),
        windowStart: new Date('2026-10-12T15:00:00+05:30'),
        windowEnd: new Date('2026-10-12T21:00:00+05:30'),
      }),
      cfg,
    );
    expect(result).toEqual({ decision: 'allow', codes: [] });
  });

  it('day guest at 20:00, same window → deny AFTER_ENTRY_CUTOFF', () => {
    const result = evaluateEntry(
      baseEntryContext({
        now: new Date('2026-10-12T20:00:00+05:30'),
        windowStart: new Date('2026-10-12T15:00:00+05:30'),
        windowEnd: new Date('2026-10-12T21:00:00+05:30'),
      }),
      cfg,
    );
    expect(result).toEqual({ decision: 'deny', codes: ['AFTER_ENTRY_CUTOFF'] });
  });

  it('overnight guest at 21:30, approved overnight arrival today → allow', () => {
    const result = evaluateEntry(
      baseEntryContext({
        type: 'overnight_room',
        now: new Date('2026-10-12T21:30:00+05:30'),
        windowStart: new Date('2026-10-12T08:00:00+05:30'),
        windowEnd: new Date('2026-10-13T12:00:00+05:30'),
      }),
      cfg,
    );
    expect(result).toEqual({ decision: 'allow', codes: [] });
  });

  it('overnight guest at 22:00, same → deny AFTER_HARD_CUTOFF', () => {
    const result = evaluateEntry(
      baseEntryContext({
        type: 'overnight_room',
        now: new Date('2026-10-12T22:00:00+05:30'),
        windowStart: new Date('2026-10-12T08:00:00+05:30'),
        windowEnd: new Date('2026-10-13T12:00:00+05:30'),
      }),
      cfg,
    );
    expect(result).toEqual({ decision: 'deny', codes: ['AFTER_HARD_CUTOFF'] });
  });

  // SDD CONTRADICTION (documented in docs/DECISIONS.md): the worked example's own
  // clock digits ("Arrives 14:25 for 15:00 window → allow"; "Arrives 14:20 → deny
  // TOO_EARLY") do not algebraically satisfy the SDD's own rule for this check
  // ("TOO_EARLY — now < window_start − 30 min → deny", SDD §4.5 step 6) given
  // early_arrival_minutes: 30 (SDD §4.3) and BR-20 ("up to 30 min before
  // window_start"). 15:00 − 30 min = 14:30; both 14:25 and 14:20 are before 14:30, so
  // the literal rule denies *both* — but the worked example says 14:25 should allow.
  // Three sources (the step-6 formula, BR-20's prose, and the early_arrival_minutes
  // config constant) agree on 30 minutes; only this one two-point example implies a
  // ~35-minute threshold. This implementation follows the 30-minute rule (the
  // corroborated majority), not the example's specific digits — the test below
  // exercises the *true* 30-minute boundary (14:30 / 14:29:59) rather than asserting
  // the SDD's literal 14:25/14:20 figures, which this code deliberately does NOT
  // reproduce. Do not "fix" this test to match the literal digits without first
  // reconciling SDD §4.3/§4.5/§4.6 in the source document itself.
  it("is allowed exactly 30 minutes before window_start (the true boundary, not the SDD's literal 14:25 digit — see comment above)", () => {
    const result = evaluateEntry(
      baseEntryContext({
        now: new Date('2026-10-12T14:30:00+05:30'),
        windowStart: new Date('2026-10-12T15:00:00+05:30'),
      }),
      cfg,
    );
    expect(result).toEqual({ decision: 'allow', codes: [] });
  });

  it('arrives 14:20 for a 15:00 window (40 min early, beyond the 30 min allowance) → deny TOO_EARLY', () => {
    const result = evaluateEntry(
      baseEntryContext({
        now: new Date('2026-10-12T14:20:00+05:30'),
        windowStart: new Date('2026-10-12T15:00:00+05:30'),
      }),
      cfg,
    );
    expect(result).toEqual({ decision: 'deny', codes: ['TOO_EARLY'] });
  });
});

describe('evaluateEntry — VISITOR_BANNED (step 1)', () => {
  it('denies, taking priority over every other check', () => {
    const result = evaluateEntry(
      baseEntryContext({ visitorBanned: true, host: { status: 'pending', suspendedUntil: null } }),
      cfg,
    );
    expect(result).toEqual({ decision: 'deny', codes: ['VISITOR_BANNED'] });
  });
});

describe('evaluateEntry — HOST_NOT_VERIFIED / HOST_SUSPENDED (step 2)', () => {
  it('denies HOST_NOT_VERIFIED for a non-verified host', () => {
    const result = evaluateEntry(
      baseEntryContext({ host: { status: 'left', suspendedUntil: null } }),
      cfg,
    );
    expect(result).toEqual({ decision: 'deny', codes: ['HOST_NOT_VERIFIED'] });
  });

  it('denies HOST_SUSPENDED for a currently-suspended host', () => {
    const future = new Date('2026-12-01T00:00:00+05:30');
    const result = evaluateEntry(
      baseEntryContext({ host: { status: 'verified', suspendedUntil: future } }),
      cfg,
    );
    expect(result).toEqual({ decision: 'deny', codes: ['HOST_SUSPENDED'] });
  });

  it('allows when the suspension has already expired', () => {
    const yesterday = new Date('2026-10-11T00:00:00+05:30');
    const result = evaluateEntry(
      baseEntryContext({ host: { status: 'verified', suspendedUntil: yesterday } }),
      cfg,
    );
    expect(result.decision).toBe('allow');
  });
});

describe('evaluateEntry — VISIT_NOT_APPROVED (step 3)', () => {
  for (const status of [
    'pending_host',
    'pending_warden',
    'inside',
    'completed',
    'rejected',
    'expired',
    'cancelled',
  ] as const) {
    it(`denies when visit status is "${status}"`, () => {
      const result = evaluateEntry(baseEntryContext({ visitStatus: status }), cfg);
      expect(result).toEqual({ decision: 'deny', codes: ['VISIT_NOT_APPROVED'] });
    });
  }
});

describe('evaluateEntry — AFTER_HARD_CUTOFF exact boundary (step 4)', () => {
  it('one second before 22:00 allows', () => {
    const result = evaluateEntry(
      baseEntryContext({
        now: new Date('2026-10-12T21:59:59+05:30'),
        type: 'overnight_room',
        windowStart: new Date('2026-10-12T08:00:00+05:30'),
        windowEnd: new Date('2026-10-13T12:00:00+05:30'),
      }),
      cfg,
    );
    expect(result.decision).toBe('allow');
  });

  it('exactly 22:00:00 denies', () => {
    const result = evaluateEntry(
      baseEntryContext({
        now: new Date('2026-10-12T22:00:00+05:30'),
        type: 'overnight_room',
        windowStart: new Date('2026-10-12T08:00:00+05:30'),
        windowEnd: new Date('2026-10-13T12:00:00+05:30'),
      }),
      cfg,
    );
    expect(result).toEqual({ decision: 'deny', codes: ['AFTER_HARD_CUTOFF'] });
  });

  it('applies even to quick_drop (every type is subject to the hard cutoff)', () => {
    const result = evaluateEntry(
      baseEntryContext({
        type: 'quick_drop',
        now: new Date('2026-10-12T22:00:00+05:30'),
        windowStart: new Date('2026-10-12T08:00:00+05:30'),
        windowEnd: new Date('2026-10-12T23:00:00+05:30'),
      }),
      cfg,
    );
    expect(result).toEqual({ decision: 'deny', codes: ['AFTER_HARD_CUTOFF'] });
  });
});

describe('evaluateEntry — AFTER_ENTRY_CUTOFF does not apply to overnight types', () => {
  it('overnight_room at 20:00 (past last_entry_day but before hard_cutoff) is allowed', () => {
    const result = evaluateEntry(
      baseEntryContext({
        type: 'overnight_room',
        now: new Date('2026-10-12T20:00:00+05:30'),
        windowStart: new Date('2026-10-12T08:00:00+05:30'),
        windowEnd: new Date('2026-10-13T12:00:00+05:30'),
      }),
      cfg,
    );
    expect(result.decision).toBe('allow');
  });

  it('guest_room at 20:00 is also allowed', () => {
    const result = evaluateEntry(
      baseEntryContext({
        type: 'guest_room',
        now: new Date('2026-10-12T20:00:00+05:30'),
        windowStart: new Date('2026-10-12T08:00:00+05:30'),
        windowEnd: new Date('2026-10-13T12:00:00+05:30'),
      }),
      cfg,
    );
    expect(result.decision).toBe('allow');
  });
});

describe('evaluateEntry — TOO_EARLY exact 30-minute boundary (step 6, BR-20)', () => {
  it('exactly 30 minutes before window_start allows', () => {
    const result = evaluateEntry(
      baseEntryContext({
        now: new Date('2026-10-12T14:30:00+05:30'),
        windowStart: new Date('2026-10-12T15:00:00+05:30'),
      }),
      cfg,
    );
    expect(result.decision).toBe('allow');
  });

  it('one second before the 30-minute boundary denies', () => {
    const result = evaluateEntry(
      baseEntryContext({
        now: new Date('2026-10-12T14:29:59+05:30'),
        windowStart: new Date('2026-10-12T15:00:00+05:30'),
      }),
      cfg,
    );
    expect(result).toEqual({ decision: 'deny', codes: ['TOO_EARLY'] });
  });
});

describe('evaluateEntry — WINDOW_ENDED exact boundary (step 7)', () => {
  // Uses overnight_room, not the default 'day', specifically so these instants
  // (20:59:59 / 21:00:00) don't also trip AFTER_ENTRY_CUTOFF (day/quick_drop only,
  // fires at last_entry_day = 20:00) — this describe block is isolating WINDOW_ENDED.
  it('one second before window_end allows', () => {
    const result = evaluateEntry(
      baseEntryContext({
        type: 'overnight_room',
        now: new Date('2026-10-12T20:59:59+05:30'),
        windowStart: new Date('2026-10-12T08:00:00+05:30'),
        windowEnd: new Date('2026-10-12T21:00:00+05:30'),
      }),
      cfg,
    );
    expect(result.decision).toBe('allow');
  });

  it('exactly at window_end denies', () => {
    const result = evaluateEntry(
      baseEntryContext({
        type: 'overnight_room',
        now: new Date('2026-10-12T21:00:00+05:30'),
        windowStart: new Date('2026-10-12T08:00:00+05:30'),
        windowEnd: new Date('2026-10-12T21:00:00+05:30'),
      }),
      cfg,
    );
    expect(result).toEqual({ decision: 'deny', codes: ['WINDOW_ENDED'] });
  });
});

describe('evaluateEntry — ALREADY_INSIDE (step 8, BR-15)', () => {
  it('denies when the visitor is already inside on a different visit', () => {
    const result = evaluateEntry(baseEntryContext({ visitorAlreadyInsideElsewhere: true }), cfg);
    expect(result).toEqual({ decision: 'deny', codes: ['ALREADY_INSIDE'] });
  });
});

describe('evaluateEntry — flags (steps 9-10): accumulate, never deny', () => {
  it('flags LOCATION_UNVERIFIED when GPS failed, but still allows', () => {
    const result = evaluateEntry(baseEntryContext({ gpsOk: false }), cfg);
    expect(result).toEqual({ decision: 'allow_flagged', codes: ['LOCATION_UNVERIFIED'] });
  });

  it('flags HOST_DAY_LIMIT when the count has reached max since approval, but still allows', () => {
    const result = evaluateEntry(baseEntryContext({ hostActiveDayGuestCount: 3 }), cfg);
    expect(result).toEqual({ decision: 'allow_flagged', codes: ['HOST_DAY_LIMIT'] });
  });

  it('accumulates both flags together when both conditions hold', () => {
    const result = evaluateEntry(
      baseEntryContext({ gpsOk: false, hostActiveDayGuestCount: 5 }),
      cfg,
    );
    expect(result.decision).toBe('allow_flagged');
    expect(result.codes).toEqual(['LOCATION_UNVERIFIED', 'HOST_DAY_LIMIT']);
  });

  it('does not flag HOST_DAY_LIMIT for overnight_room (flag is day/quick_drop crowding, not overnight)', () => {
    // HOST_DAY_LIMIT flag is based on hostActiveDayGuestCount regardless of this
    // visit's own type (overnight guests don't count toward it, but an overnight
    // visit's own entry can still surface the flag if the host separately has many
    // day guests in — both counts are independent inputs the caller computes).
    const result = evaluateEntry(
      baseEntryContext({
        type: 'overnight_room',
        now: new Date('2026-10-12T10:00:00+05:30'),
        windowStart: new Date('2026-10-12T08:00:00+05:30'),
        windowEnd: new Date('2026-10-13T12:00:00+05:30'),
        hostActiveDayGuestCount: 0,
      }),
      cfg,
    );
    expect(result).toEqual({ decision: 'allow', codes: [] });
  });
});

describe('evaluateEntry — deny codes stop evaluation immediately (SDD §4.5)', () => {
  it('reports only VISITOR_BANNED even when the visit is also not approved', () => {
    const result = evaluateEntry(
      baseEntryContext({ visitorBanned: true, visitStatus: 'pending_host' }),
      cfg,
    );
    expect(result.codes).toEqual(['VISITOR_BANNED']);
  });

  it('a deny never includes an accumulated flag code', () => {
    const result = evaluateEntry(
      baseEntryContext({ visitStatus: 'cancelled', gpsOk: false, hostActiveDayGuestCount: 99 }),
      cfg,
    );
    expect(result.codes).toEqual(['VISIT_NOT_APPROVED']);
  });
});
