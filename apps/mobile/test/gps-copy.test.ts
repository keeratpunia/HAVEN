import { copyFor } from '@haven/shared';
import { copyKeyForGpsFailure } from '../lib/gps-copy';

describe('GPS failure messages (§13.6)', () => {
  it('uses the SDD texts and never the generic error for a missing fix', () => {
    expect(copyFor(copyKeyForGpsFailure('outside_geofence')).title).toBe(
      "You're not at the gate yet",
    );
    for (const f of [
      'low_accuracy',
      'no_location',
      'stale_fix',
      'timeout',
      'unavailable',
      'unsupported',
    ]) {
      expect(copyFor(copyKeyForGpsFailure(f)).title).toBe("We can't pin your location");
    }
    expect(copyFor(copyKeyForGpsFailure('location_denied')).title).toBe(
      'Location is turned off for HAVEN',
    );
  });

  it('tells a phone user how to turn location back on in Chrome and iPhone Safari', () => {
    const body = copyFor(copyKeyForGpsFailure('location_denied')).body;
    expect(body).toContain('Android (Chrome)');
    expect(body).toContain('iPhone (Safari)');
    expect(body).toContain('Location Services');
  });
});
