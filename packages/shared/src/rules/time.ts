import { DateTime } from 'luxon';

/**
 * Timezone-correct time maths (SDD §4.4: "Uses luxon for timezone maths"; SDD §9.13:
 * "Business-time comparisons convert now() to the hostel timezone with luxon before
 * comparing with config times like '20:00'"). No function here reads the system
 * clock — every `Date`/timezone pair is a parameter.
 */

/** Converts a UTC instant to a luxon DateTime in the hostel's timezone. */
export function toHostelLocal(instant: Date, timezone: string): DateTime {
  return DateTime.fromJSDate(instant, { zone: 'utc' }).setZone(timezone);
}

/** Parses a "HH:MM" config time string into {hour, minute}. */
export function parseTimeOfDay(value: string): { hour: number; minute: number } {
  const [hourStr, minuteStr] = value.split(':');
  return { hour: Number(hourStr), minute: Number(minuteStr) };
}

/**
 * True if `instant`'s local time-of-day (in `timezone`) is at or after `timeOfDay`
 * ("HH:MM"), on whatever local calendar date `instant` falls on. Used for cutoff
 * checks (BR-02, BR-03) where only the clock time matters, not the date.
 */
export function isLocalTimeAtOrAfter(instant: Date, timeOfDay: string, timezone: string): boolean {
  const local = toHostelLocal(instant, timezone);
  const { hour, minute } = parseTimeOfDay(timeOfDay);
  const threshold = local.set({ hour, minute, second: 0, millisecond: 0 });
  return local >= threshold;
}

/** The inverse comparison — local time-of-day is at or before `timeOfDay`. */
export function isLocalTimeAtOrBefore(instant: Date, timeOfDay: string, timezone: string): boolean {
  const local = toHostelLocal(instant, timezone);
  const { hour, minute } = parseTimeOfDay(timeOfDay);
  const threshold = local.set({ hour, minute, second: 0, millisecond: 0 });
  return local <= threshold;
}

/** True if `a` and `b` fall on the same local calendar date in `timezone`. */
export function isSameLocalDate(a: Date, b: Date, timezone: string): boolean {
  return toHostelLocal(a, timezone).toISODate() === toHostelLocal(b, timezone).toISODate();
}

/** The local calendar date (YYYY-MM-DD) `instant` falls on, in `timezone`. */
export function toLocalDateString(instant: Date, timezone: string): string {
  // ISODate() is only null for an invalid DateTime, which toHostelLocal never
  // produces from a valid Date — safe to assert.
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- see comment above
  return toHostelLocal(instant, timezone).toISODate()!;
}

/** Days between two local dates (`b` − `a`), both YYYY-MM-DD, in the given timezone. */
export function daysBetween(a: string, b: string, timezone: string): number {
  const start = DateTime.fromISO(a, { zone: timezone });
  const end = DateTime.fromISO(b, { zone: timezone });
  return Math.round(end.diff(start, 'days').days);
}

/** Combines a local YYYY-MM-DD date with an "HH:MM" time-of-day into a UTC Date. */
export function localDateTimeToUtc(date: string, timeOfDay: string, timezone: string): Date {
  const { hour, minute } = parseTimeOfDay(timeOfDay);
  const local = DateTime.fromISO(date, { zone: timezone }).set({
    hour,
    minute,
    second: 0,
    millisecond: 0,
  });
  return local.toJSDate();
}
