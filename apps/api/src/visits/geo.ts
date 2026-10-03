/**
 * Haversine distance between two lat/lng points, in metres. Used to decide
 * `locationVerified` for check-in/check-out against a gate's configured radius (SDD
 * §9.2's geofence concept) — the full gate module (rotating QR tokens, scan sessions,
 * `GATE_TOKEN_*` crypto) is out of scope for this milestone (see docs/DECISIONS.md);
 * this is the one real piece of it this milestone needs: "is the guest near the gate."
 */
export function haversineDistanceMeters(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
): number {
  const R = 6_371_000;
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const sinLat = Math.sin(dLat / 2);
  const sinLng = Math.sin(dLng / 2);
  const h = sinLat * sinLat + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * sinLng * sinLng;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}
