/**
 * INTEGRATION NOTES (src/lib/distance.ts)
 *
 * Pure great-circle helpers. No dependency, no I/O.
 *
 * Public surface:
 *   type LatLng
 *   haversineMiles(a, b): number
 *   distanceMiles(from: LatLng | null | undefined, to: LatLng): number | null
 *   formatDistance(miles: number | null | undefined): string | null
 *
 * The important behaviour for the UI: when there is no reference point, `distanceMiles`
 * returns `null` and `formatDistance(null)` returns `null`. Nothing here invents a centre
 * of the city as a stand-in origin — an "unknown" distance is shown as absent, not wrong.
 *
 * `formatDistance` switches from miles to feet below 0.1 mi (528 ft), which is where
 * "0.1 mi" stops being more useful than a round number of feet.
 */

export interface LatLng {
  readonly lat: number;
  readonly lng: number;
}

/** Mean Earth radius, miles (IUGG). */
const EARTH_RADIUS_MILES = 3958.7613;
const FEET_PER_MILE = 5280;

/** Below this many miles we report feet instead. */
export const FEET_THRESHOLD_MILES = 0.1;

/** Feet are rounded to this increment — "480 ft" reads better than "475.2 ft". */
const FEET_ROUNDING = 10;

function toRadians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

export function haversineMiles(a: LatLng, b: LatLng): number {
  const lat1 = toRadians(a.lat);
  const lat2 = toRadians(b.lat);
  const deltaLat = toRadians(b.lat - a.lat);
  const deltaLng = toRadians(b.lng - a.lng);

  const h =
    Math.sin(deltaLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLng / 2) ** 2;

  // asin(min(1, h)) rather than 2*asin(sqrt(h)) keeps the argument in domain for
  // antipodal points, where h can round to slightly above 1.
  return 2 * EARTH_RADIUS_MILES * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** `null` when there is no origin, so the caller can omit the distance entirely. */
export function distanceMiles(
  from: LatLng | null | undefined,
  to: LatLng,
): number | null {
  if (!from) return null;
  if (!Number.isFinite(from.lat) || !Number.isFinite(from.lng)) return null;
  if (!Number.isFinite(to.lat) || !Number.isFinite(to.lng)) return null;
  return haversineMiles(from, to);
}

/** `"480 ft"` under 0.1 mi, `"0.3 mi"` at or above it, `null` for a null input. */
export function formatDistance(miles: number | null | undefined): string | null {
  if (miles === null || miles === undefined || !Number.isFinite(miles)) return null;
  if (miles < 0) return null;

  if (miles < FEET_THRESHOLD_MILES) {
    const feet = Math.round((miles * FEET_PER_MILE) / FEET_ROUNDING) * FEET_ROUNDING;
    return `${feet} ft`;
  }

  return `${miles.toFixed(1)} mi`;
}

/**
 * Convenience for the detail sheet: distance from the visitor's position when the
 * browser has given us one and the app is allowed to use it, otherwise `null`.
 */
export function describeDistance(
  origin: LatLng | null | undefined,
  target: LatLng,
): string | null {
  return formatDistance(distanceMiles(origin, target));
}
