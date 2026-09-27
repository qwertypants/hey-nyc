/**
 * INTEGRATION NOTES (src/lib/bounds.ts)
 *
 * The map's visible extent as plain numbers. `src/map/controller.ts` produces these from
 * MapLibre's `getBounds()`; Stream C's list view consumes them to show only what is on
 * screen. Defined here so the list filter stays testable without a map.
 *
 * Public surface:
 *   type MapBounds, EMPTY_BOUNDS, boundsContain, boundsAreValid, unionBounds, formatBounds
 */

export interface MapBounds {
  readonly west: number;
  readonly south: number;
  readonly east: number;
  readonly north: number;
}

/** "Nothing is filtered by bounds" — every point in the dataset is inside. */
export const EMPTY_BOUNDS: MapBounds = {
  west: Number.NEGATIVE_INFINITY,
  south: Number.NEGATIVE_INFINITY,
  east: Number.POSITIVE_INFINITY,
  north: Number.POSITIVE_INFINITY,
};

export function boundsAreValid(bounds: MapBounds | null | undefined): bounds is MapBounds {
  if (!bounds) return false;
  const { west, south, east, north } = bounds;
  return (
    Number.isFinite(west) &&
    Number.isFinite(south) &&
    Number.isFinite(east) &&
    Number.isFinite(north) &&
    west < east &&
    south < north
  );
}

export function boundsContain(
  bounds: MapBounds | null | undefined,
  lat: number,
  lng: number,
): boolean {
  if (!bounds) return true;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return false;
  return lng >= bounds.west && lng <= bounds.east && lat >= bounds.south && lat <= bounds.north;
}

export function unionBounds(a: MapBounds, b: MapBounds): MapBounds {
  return {
    west: Math.min(a.west, b.west),
    south: Math.min(a.south, b.south),
    east: Math.max(a.east, b.east),
    north: Math.max(a.north, b.north),
  };
}

/** Compact "40.70, -73.97" style label for debugging and share-sheet text. */
export function formatBounds(bounds: MapBounds): string {
  return [
    `${bounds.south.toFixed(3)}, ${bounds.west.toFixed(3)}`,
    `${bounds.north.toFixed(3)}, ${bounds.east.toFixed(3)}`,
  ].join(' to ');
}
