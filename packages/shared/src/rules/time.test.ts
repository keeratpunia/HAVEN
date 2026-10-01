import { describe, expect, it } from 'vitest';
import {
  daysBetween,
  isLocalTimeAtOrAfter,
  isLocalTimeAtOrBefore,
  isSameLocalDate,
  localDateTimeToUtc,
  toLocalDateString,
} from './time.js';

const TZ = 'Asia/Kolkata'; // UTC+5:30, no DST

describe('isLocalTimeAtOrAfter — exact boundary (SDD §4.5 AFTER_ENTRY_CUTOFF at 20:00)', () => {
  it('one second before 20:00 IST is NOT at-or-after', () => {
    const instant = new Date('2026-10-12T19:59:59+05:30');
    expect(isLocalTimeAtOrAfter(instant, '20:00', TZ)).toBe(false);
  });

  it('exactly 20:00:00 IST IS at-or-after', () => {
    const instant = new Date('2026-10-12T20:00:00+05:30');
    expect(isLocalTimeAtOrAfter(instant, '20:00', TZ)).toBe(true);
  });

  it('one second after 20:00 IST IS at-or-after', () => {
    const instant = new Date('2026-10-12T20:00:01+05:30');
    expect(isLocalTimeAtOrAfter(instant, '20:00', TZ)).toBe(true);
  });
});

describe('isLocalTimeAtOrBefore — exact boundary', () => {
  it('exactly 22:00:00 IST IS at-or-before 22:00', () => {
    expect(isLocalTimeAtOrBefore(new Date('2026-10-12T22:00:00+05:30'), '22:00', TZ)).toBe(true);
  });

  it('one second after 22:00 IST is NOT at-or-before', () => {
    expect(isLocalTimeAtOrBefore(new Date('2026-10-12T22:00:01+05:30'), '22:00', TZ)).toBe(false);
  });
});

describe('isSameLocalDate — timezone-correct, not UTC-date comparison', () => {
  it('two instants on the same IST calendar date, even though their UTC dates differ', () => {
    // 2026-10-12T23:00+05:30 = 2026-10-12T17:30 UTC; 2026-10-12T00:30+05:30 = 2026-10-11T19:00 UTC.
    // Both are IST-local 12 Oct, but their UTC dates are 12 Oct and 11 Oct respectively.
    const a = new Date('2026-10-12T00:30:00+05:30');
    const b = new Date('2026-10-12T23:00:00+05:30');
    expect(isSameLocalDate(a, b, TZ)).toBe(true);
  });

  it('two instants that are genuinely on different IST calendar dates', () => {
    const a = new Date('2026-10-12T23:59:59+05:30');
    const b = new Date('2026-10-13T00:00:01+05:30');
    expect(isSameLocalDate(a, b, TZ)).toBe(false);
  });

  it('midnight boundary: 23:59:59 vs 00:00:00 the next IST day are different dates', () => {
    const a = new Date('2026-10-12T23:59:59+05:30');
    const b = new Date('2026-10-13T00:00:00+05:30');
    expect(isSameLocalDate(a, b, TZ)).toBe(false);
  });
});

describe('toLocalDateString', () => {
  it('returns the IST calendar date, not the UTC date, near midnight', () => {
    // 2026-10-12T00:30+05:30 is 2026-10-11T19:00 UTC — UTC date would be 11 Oct, IST date is 12 Oct.
    const instant = new Date('2026-10-12T00:30:00+05:30');
    expect(toLocalDateString(instant, TZ)).toBe('2026-10-12');
  });
});

describe('daysBetween', () => {
  it('is 0 for the same date', () => {
    expect(daysBetween('2026-10-12', '2026-10-12', TZ)).toBe(0);
  });

  it('counts forward across a month boundary', () => {
    expect(daysBetween('2026-10-30', '2026-11-02', TZ)).toBe(3);
  });

  it('counts forward across a year boundary', () => {
    expect(daysBetween('2026-12-30', '2027-01-02', TZ)).toBe(3);
  });

  it('is negative when b is before a', () => {
    expect(daysBetween('2026-10-12', '2026-10-10', TZ)).toBe(-2);
  });
});

describe('localDateTimeToUtc', () => {
  it('combines an IST date and time-of-day into the correct UTC instant', () => {
    const utc = localDateTimeToUtc('2026-10-12', '08:00', TZ);
    // 08:00 IST = 02:30 UTC (IST is UTC+5:30)
    expect(utc.toISOString()).toBe('2026-10-12T02:30:00.000Z');
  });
});
