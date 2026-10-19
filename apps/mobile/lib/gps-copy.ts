/**
 * Which §13.6 message a guest sees when the gate can't confirm their location. The SDD
 * gives text for two cases: OUT_OF_GEOFENCE ("You're not at the gate yet") and
 * low_accuracy ("We can't pin your location — Turn on GPS / Location, step out from
 * under a roof, and try again"). Every other "no usable fix" case — no location at all
 * (Android reports Location switched off as unavailable), a stale fix, a browser
 * timeout — is the same situation for the guest, so it gets the low_accuracy text
 * instead of the generic "Something went wrong" (found in the 2026-10-19 rehearsal).
 * A refused permission has its own text (location_denied, DEC-022).
 */
const NO_USABLE_FIX = new Set([
  'no_location',
  'stale_fix',
  'timeout',
  'unavailable',
  'unsupported',
]);

export function copyKeyForGpsFailure(failure: string): string {
  if (failure === 'outside_geofence') return 'OUT_OF_GEOFENCE';
  if (NO_USABLE_FIX.has(failure)) return 'low_accuracy';
  return failure;
}
