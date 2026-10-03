import { Platform } from 'react-native';
import type { ScanLocation } from '../api/client.js';

/**
 * Client location capture for a scan session (SDD §9.3): `watchPosition` with
 * `{enableHighAccuracy: true, maximumAge: 0, timeout: 15000}`; keeps the best (lowest
 * accuracy) fix; stops when accuracy <= 20m or after 10s, whichever first. Permission
 * denied/unavailable/timeout -> `{location: null, locationError: <reason>}` (the SDD's
 * own wording — the server has no equivalent `locationError` enum, this is purely for
 * the UI to explain what happened).
 */

const GOOD_ENOUGH_ACCURACY_M = 20;
const STOP_AFTER_MS = 10_000;

export function captureScanLocation(): Promise<{
  location: ScanLocation | null;
  locationError: string | null;
}> {
  if (Platform.OS !== 'web' || typeof navigator === 'undefined' || !navigator.geolocation) {
    return Promise.resolve({ location: null, locationError: 'unsupported' });
  }

  return new Promise((resolve) => {
    let best: ScanLocation | null = null;
    let watchId: number | null = null;
    let settled = false;

    const finish = (location: ScanLocation | null, locationError: string | null) => {
      if (settled) return;
      settled = true;
      if (watchId !== null) navigator.geolocation.clearWatch(watchId);
      clearTimeout(timer);
      resolve({ location, locationError });
    };

    const timer = setTimeout(() => finish(best, best ? null : 'timeout'), STOP_AFTER_MS);

    watchId = navigator.geolocation.watchPosition(
      (position) => {
        const accuracy = position.coords.accuracy;
        const fixAgeMs = Date.now() - position.timestamp;
        if (!best || accuracy < best.accuracy) {
          best = {
            lat: position.coords.latitude,
            lng: position.coords.longitude,
            accuracy,
            fixAgeMs,
          };
        }
        if (accuracy <= GOOD_ENOUGH_ACCURACY_M) {
          finish(best, null);
        }
      },
      (err) => {
        finish(null, err.code === err.PERMISSION_DENIED ? 'denied' : 'unavailable');
      },
      { enableHighAccuracy: true, maximumAge: 0, timeout: 15_000 },
    );
  });
}
