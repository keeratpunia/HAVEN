/**
 * FR-56 / F8 step 4: "App takes 5 GPS fixes 2 s apart, discards any with accuracy > 30 m,
 * averages the rest". Pure, so it can be unit-tested; W-09 does the capturing.
 */
export const GATE_FIX_MAX_ACCURACY_M = 30;

export interface Fix {
  lat: number;
  lng: number;
  accuracy: number;
}

export function averageGateFixes(
  fixes: readonly Fix[],
  maxAccuracyM = GATE_FIX_MAX_ACCURACY_M,
): (Fix & { used: number }) | null {
  const good = fixes.filter((f) => f.accuracy <= maxAccuracyM);
  if (good.length === 0) return null;
  const avg = (k: keyof Fix) => good.reduce((s, f) => s + f[k], 0) / good.length;
  return { lat: avg('lat'), lng: avg('lng'), accuracy: avg('accuracy'), used: good.length };
}
