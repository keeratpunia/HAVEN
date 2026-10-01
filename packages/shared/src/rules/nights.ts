import { DateTime } from 'luxon';

/**
 * SDD §4.4: `function nightsBetween(arrivalDate: string, departureDate: string):
 * string[];` — "ISO dates of each night". A stay from `arrivalDate` to
 * `departureDate` occupies one night per date from `arrivalDate` up to, but not
 * including, `departureDate` (the guest checks out on `departureDate`, not sleeps
 * another night there). Matches SDD §4.6's worked examples exactly:
 *   - 30 Oct → 1 Nov = nights [30 Oct, 31 Oct]
 *   - 31 Oct → 2 Nov = nights [31 Oct, 1 Nov]
 */
export function nightsBetween(arrivalDate: string, departureDate: string): string[] {
  const start = DateTime.fromISO(arrivalDate);
  const end = DateTime.fromISO(departureDate);
  if (!start.isValid || !end.isValid) {
    throw new Error(`nightsBetween: invalid date(s) "${arrivalDate}" / "${departureDate}"`);
  }
  if (end <= start) {
    throw new Error(
      `nightsBetween: departureDate (${departureDate}) must be after arrivalDate (${arrivalDate})`,
    );
  }

  const nights: string[] = [];
  let cursor = start;
  while (cursor < end) {
    // ISODate() cannot be null here — `cursor` is always a valid DateTime derived by
    // adding whole days to an already-valid `start`.
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- see comment above
    nights.push(cursor.toISODate()!);
    cursor = cursor.plus({ days: 1 });
  }
  return nights;
}

/**
 * SDD §4.4: `function quotaUsed(hostNights: string[], month: string): number;` — how
 * many of `hostNights` fall in `month` (a "YYYY-MM" string). "A night belongs to the
 * month of its date" (BR-05).
 */
export function quotaUsed(hostNights: string[], month: string): number {
  return hostNights.filter((night) => night.startsWith(month)).length;
}

/** Distinct "YYYY-MM" months touched by a set of ISO-date nights, in date order. */
export function monthsTouched(nights: string[]): string[] {
  const months = new Set(nights.map((night) => night.slice(0, 7)));
  return [...months].sort();
}
