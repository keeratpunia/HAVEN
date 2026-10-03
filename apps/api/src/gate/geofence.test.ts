import { describe, expect, it } from 'vitest';
import { evaluateGeofence, type GateConfig } from './geofence.js';

const GATE_LAT = 12.9716;
const GATE_LNG = 77.5946;

/** Same gate used throughout: SDD §19.2's TC-GEO fixtures (radius 50, max accuracy 75). */
const GATE: GateConfig = { lat: GATE_LAT, lng: GATE_LNG, radiusM: 50, maxAccuracyM: 75 };

/** One degree of latitude is ~111,320m; a tiny delta gives a known, small distance. */
function pointMetersNorth(meters: number) {
  const deltaLat = meters / 111_320;
  return { lat: GATE_LAT + deltaLat, lng: GATE_LNG };
}

describe('gate geofence (SDD §9.3, §19.2 TC-GEO)', () => {
  it('TC-GEO-01: point 49m away, accuracy 20 -> gps_ok', () => {
    const result = evaluateGeofence(GATE, {
      ...pointMetersNorth(49),
      accuracy: 20,
      fixAgeMs: 1000,
    });
    expect(result.gpsOk).toBe(true);
    expect(result.gpsFailure).toBeNull();
    expect(result.distanceM).toBeCloseTo(49, 0);
  });

  it('TC-GEO-02: point 51m away -> outside_geofence', () => {
    const result = evaluateGeofence(GATE, {
      ...pointMetersNorth(51),
      accuracy: 20,
      fixAgeMs: 1000,
    });
    expect(result.gpsOk).toBe(false);
    expect(result.gpsFailure).toBe('outside_geofence');
  });

  it('TC-GEO-03: accuracy 80m -> low_accuracy', () => {
    const result = evaluateGeofence(GATE, {
      ...pointMetersNorth(10),
      accuracy: 80,
      fixAgeMs: 1000,
    });
    expect(result.gpsOk).toBe(false);
    expect(result.gpsFailure).toBe('low_accuracy');
  });

  it('TC-GEO-04: fix age 61s -> stale_fix', () => {
    const result = evaluateGeofence(GATE, {
      ...pointMetersNorth(10),
      accuracy: 20,
      fixAgeMs: 61_000,
    });
    expect(result.gpsOk).toBe(false);
    expect(result.gpsFailure).toBe('stale_fix');
  });

  it('a gate with no location set -> gate_not_configured', () => {
    const result = evaluateGeofence(
      { lat: null, lng: null, radiusM: 50, maxAccuracyM: 75 },
      { lat: 12.9716, lng: 77.5946, accuracy: 10, fixAgeMs: 1000 },
    );
    expect(result.gpsOk).toBe(false);
    expect(result.gpsFailure).toBe('gate_not_configured');
    expect(result.distanceM).toBeNull();
  });
});
