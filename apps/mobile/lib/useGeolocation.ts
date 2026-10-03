import { Platform } from 'react-native';

/**
 * Captures one GPS fix via the browser Geolocation API. SDD F3: "GPS fix fails three
 * times (accuracy too low, outside geofence, timeout) or the guest denies location
 * permission" — the caller is responsible for the 3-attempt retry UI (G-15); this
 * function makes exactly one attempt and reports which of those failure kinds it was.
 */
export type GeolocationFailure = 'denied' | 'low_accuracy' | 'timeout' | 'unsupported';

export interface GeolocationFix {
  lat: number;
  lng: number;
  accuracyM: number;
}

const MAX_ACCURACY_M = 75;

export function captureGeolocation(): Promise<
  { ok: true; fix: GeolocationFix } | { ok: false; reason: GeolocationFailure }
> {
  if (Platform.OS !== 'web' || typeof navigator === 'undefined' || !navigator.geolocation) {
    return Promise.resolve({ ok: false, reason: 'unsupported' });
  }
  return new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const accuracyM = pos.coords.accuracy;
        if (accuracyM > MAX_ACCURACY_M) {
          resolve({ ok: false, reason: 'low_accuracy' });
          return;
        }
        resolve({
          ok: true,
          fix: { lat: pos.coords.latitude, lng: pos.coords.longitude, accuracyM },
        });
      },
      (err) => {
        resolve({ ok: false, reason: err.code === err.PERMISSION_DENIED ? 'denied' : 'timeout' });
      },
      { enableHighAccuracy: true, timeout: 10_000, maximumAge: 0 },
    );
  });
}
