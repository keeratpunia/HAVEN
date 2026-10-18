import * as Location from 'expo-location';
import type { ScanLocation } from '../api/client.js';

/**
 * Native location capture (SDD §9.3): `Location.getCurrentPositionAsync({ accuracy:
 * Location.Accuracy.Highest })`. "If location.mocked === true (Android), abort with
 * 'Fake location apps must be turned off.'" — returned as `locationError: 'mocked'`
 * so the caller refuses before calling the API (CLAUDE.md §4); the server mirrors it
 * with MOCK_LOCATION (403).
 */
export async function captureScanLocation(): Promise<{
  location: ScanLocation | null;
  locationError: string | null;
}> {
  const { status } = await Location.requestForegroundPermissionsAsync();
  if (status !== Location.PermissionStatus.GRANTED)
    return { location: null, locationError: 'denied' };
  try {
    const position = await Location.getCurrentPositionAsync({
      accuracy: Location.Accuracy.Highest,
    });
    if (position.mocked) return { location: null, locationError: 'mocked' };
    return {
      location: {
        lat: position.coords.latitude,
        lng: position.coords.longitude,
        accuracy: position.coords.accuracy ?? 9999,
        fixAgeMs: Math.max(0, Date.now() - position.timestamp),
        mocked: false,
      },
      locationError: null,
    };
  } catch {
    return { location: null, locationError: 'unavailable' };
  }
}
