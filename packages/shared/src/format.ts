import { DateTime } from 'luxon';

/**
 * Display formats fixed by the SDD, shared so the API's notification templates (§15)
 * and the app's screens (§13.1 principle 6) produce identical strings.
 */

export const HOSTEL_TIMEZONE = 'Asia/Kolkata';

/** "4:42 pm" — SDD §13.1: "Show times in IST, 12-hour". */
export function formatTime12h(instant: Date | string, timezone = HOSTEL_TIMEZONE): string {
  const dt = DateTime.fromJSDate(new Date(instant), { zone: 'utc' }).setZone(timezone);
  return dt.toFormat('h:mm a').toLowerCase();
}

/** "16:42" — a 24-hour HH:MM value for time inputs (the field shows it in the user's format). */
export function formatHhMm(instant: Date | string, timezone = HOSTEL_TIMEZONE): string {
  return DateTime.fromJSDate(new Date(instant), { zone: 'utc' })
    .setZone(timezone)
    .toFormat('HH:mm');
}

/** "Sun, 12 Oct" — SDD §13.1. */
export function formatDateShort(instant: Date | string, timezone = HOSTEL_TIMEZONE): string {
  const dt = DateTime.fromJSDate(new Date(instant), { zone: 'utc' }).setZone(timezone);
  return dt.toFormat('EEE, d LLL');
}

/** "12 Oct, 4:42 pm" — SDD §9.13's display format. */
export function formatDateTime(instant: Date | string, timezone = HOSTEL_TIMEZONE): string {
  const dt = DateTime.fromJSDate(new Date(instant), { zone: 'utc' }).setZone(timezone);
  return `${dt.toFormat('d LLL')}, ${dt.toFormat('h:mm a').toLowerCase()}`;
}

/** "28 Nov 2026" — exports and reports, where the year matters (DEC-032). */
export function formatDateWithYear(instant: Date | string, timezone = HOSTEL_TIMEZONE): string {
  return DateTime.fromJSDate(new Date(instant), { zone: 'utc' })
    .setZone(timezone)
    .toFormat('d LLL yyyy');
}

/** "28 Nov 2026, 2:10 pm". */
export function formatDateTimeWithYear(instant: Date | string, timezone = HOSTEL_TIMEZONE): string {
  return `${formatDateWithYear(instant, timezone)}, ${formatTime12h(instant, timezone)}`;
}

/** A hostel-local YYYY-MM-DD date moved by `days`. */
export function plusDays(isoDate: string, days: number, timezone = HOSTEL_TIMEZONE): string {
  return DateTime.fromISO(isoDate, { zone: timezone }).plus({ days }).toISODate() ?? isoDate;
}

/** "2026-10" → "October". */
export function formatMonth(month: string): string {
  return DateTime.fromISO(`${month}-01`).toFormat('LLLL');
}

/** "Priya S." — SDD FR-25 / §12.3 `host.displayName`: first name + last initial. */
export function displayName(fullName: string): string {
  const parts = fullName.trim().split(/\s+/);
  const first = parts[0] ?? '';
  const last = parts.length > 1 ? parts[parts.length - 1] : '';
  return last ? `${first} ${last.charAt(0).toUpperCase()}.` : first;
}

export function firstName(fullName: string): string {
  return fullName.trim().split(/\s+/)[0] ?? '';
}

/** "15 min", "1 h", "2 h 30 min" — the `{duration}` placeholder in N-WALKIN. */
export function formatDuration(minutes: number): string {
  const rounded = Math.max(0, Math.round(minutes));
  const hours = Math.floor(rounded / 60);
  const mins = rounded % 60;
  if (hours === 0) return `${mins} min`;
  if (mins === 0) return `${hours} h`;
  return `${hours} h ${mins} min`;
}

/** UI labels from SDD §4.1's visit-type table. */
export const VISIT_TYPE_LABELS = {
  quick_drop: 'Quick drop-off',
  day: 'Day visit',
  overnight_room: 'Overnight in my room',
  guest_room: 'Hostel guest room',
} as const;

/**
 * SDD §15.4 messages the host shares (verbatim): T-INVITE for day / quick drop-off
 * invites, T-INVITE-OVERNIGHT once the warden approves an overnight stay.
 */
export function inviteShareText(p: {
  guestName: string;
  hostelName: string;
  windowStart: string | Date;
  windowEnd: string | Date;
  inviteUrl: string;
}): string {
  return (
    `Hi ${p.guestName}, I've added you as my guest at ${p.hostelName} on ${formatDateShort(p.windowStart)}, ` +
    `${formatTime12h(p.windowStart)}–${formatTime12h(p.windowEnd)}.\n` +
    `Open this link to get set up, then scan the QR at the gate when you arrive:\n${p.inviteUrl}`
  );
}

export function overnightInviteShareText(p: {
  guestName: string;
  hostelName: string;
  windowStart: string | Date;
  windowEnd: string | Date;
  inviteUrl: string;
}): string {
  return (
    `Hi ${p.guestName}, your stay at ${p.hostelName} from ${formatDateShort(p.windowStart)} to ` +
    `${formatDateShort(p.windowEnd)} is approved.\n` +
    `Open this link to get set up, then scan the QR at the gate when you arrive (before 10 pm):\n${p.inviteUrl}`
  );
}

/** "+91•••••43210" — the masked form used wherever a guest phone is shown to a host. */
export function maskPhone(phone: string): string {
  if (phone.length <= 7) return phone;
  return `${phone.slice(0, 3)}${'•'.repeat(phone.length - 8)}${phone.slice(-5)}`;
}
