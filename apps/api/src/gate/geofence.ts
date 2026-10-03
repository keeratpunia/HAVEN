import { haversineDistanceMeters } from '../visits/geo.js';
import type { GpsFailure } from '../db/types.js';

/**
 * Geofence check (SDD §9.3 step 2-3). Reuses `visits/geo.ts`'s haversine helper rather
 * than duplicating distance math — that module's own comment says the full gate
 * crypto/geofence system was out of scope for the milestone that added it; this is
 * that system, now built, still using the same distance primitive.
 */

export interface GateLocationInput {
  lat: number;
  lng: number;
  accuracy: number;
  /** Client-computed `Date.now() - position.timestamp`, so a wrong phone clock
   * doesn't matter (SDD §9.3 step 3 parenthetical). */
  fixAgeMs: number;
}

export interface GateConfig {
  lat: number | null;
  lng: number | null;
  radiusM: number;
  maxAccuracyM: number;
}

export interface GeofenceResult {
  gpsOk: boolean;
  gpsFailure: GpsFailure | null;
  distanceM: number | null;
}

const MAX_FIX_AGE_MS = 60_000;

/**
 * SDD §9.3 step 3: `gps_ok = location != null && accuracy <= maxAccuracyM && distance
 * <= radiusM && fixAgeMs <= 60000`. `location: null` (permission denied/unavailable/
 * timeout) is the caller's job to detect — this function always receives a location,
 * or the caller never calls it (see `scanSessions.ts`).
 */
export function evaluateGeofence(gate: GateConfig, location: GateLocationInput): GeofenceResult {
  if (gate.lat === null || gate.lng === null) {
    return { gpsOk: false, gpsFailure: 'gate_not_configured', distanceM: null };
  }

  const distanceM = haversineDistanceMeters({ lat: gate.lat, lng: gate.lng }, location);

  if (location.fixAgeMs > MAX_FIX_AGE_MS) {
    return { gpsOk: false, gpsFailure: 'stale_fix', distanceM };
  }
  if (location.accuracy > gate.maxAccuracyM) {
    return { gpsOk: false, gpsFailure: 'low_accuracy', distanceM };
  }
  if (distanceM > gate.radiusM) {
    return { gpsOk: false, gpsFailure: 'outside_geofence', distanceM };
  }
  return { gpsOk: true, gpsFailure: null, distanceM };
}
