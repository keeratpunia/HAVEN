/**
 * SDD §13.1 principle 6: "Show times in IST, 12-hour, e.g. '4:42 pm', 'Sun, 12 Oct'."
 * Every guest-facing screen formats dates/times through these two functions only, so
 * the format never drifts screen to screen.
 */
const IST_TIME = new Intl.DateTimeFormat('en-IN', {
  timeZone: 'Asia/Kolkata',
  hour: 'numeric',
  minute: '2-digit',
  hour12: true,
});
const IST_DATE = new Intl.DateTimeFormat('en-IN', {
  timeZone: 'Asia/Kolkata',
  weekday: 'short',
  day: 'numeric',
  month: 'short',
});

export function formatTimeIst(iso: string): string {
  return IST_TIME.format(new Date(iso)).toLowerCase().replace(/\s/g, '');
}

export function formatDateIst(iso: string): string {
  return IST_DATE.format(new Date(iso));
}
