import { describe, expect, it } from 'vitest';
import { monthsTouched, nightsBetween, quotaUsed } from './nights.js';

describe('nightsBetween (SDD §4.4, worked examples SDD §4.6)', () => {
  it('30 Oct → 1 Nov = nights [30 Oct, 31 Oct] (worked example: host had 1 Oct night, total becomes 3)', () => {
    expect(nightsBetween('2026-10-30', '2026-11-01')).toEqual(['2026-10-30', '2026-10-31']);
  });

  it('31 Oct → 2 Nov = nights [31 Oct, 1 Nov] (worked example: host had 3 Oct nights, would become 4)', () => {
    expect(nightsBetween('2026-10-31', '2026-11-02')).toEqual(['2026-10-31', '2026-11-01']);
  });

  it('a single night (arrival, arrival+1) returns exactly one date', () => {
    expect(nightsBetween('2026-10-12', '2026-10-13')).toEqual(['2026-10-12']);
  });

  it('a multi-night stay returns one entry per night, not per day inclusive of departure', () => {
    expect(nightsBetween('2026-10-01', '2026-10-05')).toEqual([
      '2026-10-01',
      '2026-10-02',
      '2026-10-03',
      '2026-10-04',
    ]);
  });

  it('crosses a year boundary correctly', () => {
    expect(nightsBetween('2026-12-30', '2027-01-02')).toEqual([
      '2026-12-30',
      '2026-12-31',
      '2027-01-01',
    ]);
  });

  it('handles a leap-year February correctly (2028 is a leap year)', () => {
    expect(nightsBetween('2028-02-27', '2028-03-01')).toEqual([
      '2028-02-27',
      '2028-02-28',
      '2028-02-29',
    ]);
  });

  it('handles a non-leap-year February correctly (2026 is not a leap year)', () => {
    expect(nightsBetween('2026-02-27', '2026-03-01')).toEqual(['2026-02-27', '2026-02-28']);
  });

  it('throws when departureDate is not after arrivalDate (same date)', () => {
    expect(() => nightsBetween('2026-10-12', '2026-10-12')).toThrow();
  });

  it('throws when departureDate is before arrivalDate', () => {
    expect(() => nightsBetween('2026-10-12', '2026-10-01')).toThrow();
  });

  it('throws on an invalid date string', () => {
    expect(() => nightsBetween('not-a-date', '2026-10-13')).toThrow();
  });
});

describe('quotaUsed (SDD §4.4)', () => {
  it('counts nights within the given month only', () => {
    const nights = ['2026-10-30', '2026-10-31', '2026-11-01'];
    expect(quotaUsed(nights, '2026-10')).toBe(2);
    expect(quotaUsed(nights, '2026-11')).toBe(1);
    expect(quotaUsed(nights, '2026-12')).toBe(0);
  });

  it('returns 0 for an empty nights array', () => {
    expect(quotaUsed([], '2026-10')).toBe(0);
  });

  it('matches the worked example: host has 3 nights in October → quota fully used', () => {
    const nights = ['2026-10-01', '2026-10-02', '2026-10-03'];
    expect(quotaUsed(nights, '2026-10')).toBe(3);
  });
});

describe('monthsTouched', () => {
  it('returns distinct months in order, even if nights are unordered across months', () => {
    expect(monthsTouched(['2026-10-31', '2026-11-01', '2026-10-30'])).toEqual([
      '2026-10',
      '2026-11',
    ]);
  });

  it('returns a single month for a stay entirely within one month', () => {
    expect(monthsTouched(['2026-10-01', '2026-10-02'])).toEqual(['2026-10']);
  });
});
