/**
 * The list's contents: filtered by the active filters, then clipped to what the map is
 * currently showing.
 *
 * This is the single source of truth for "N places in this area", the list rows and the
 * empty state, so the count in the bottom bar can never disagree with the list below it.
 *
 * Two rules the code exists to enforce:
 *
 * 1. `bounds === null` means "the map has not reported an extent yet", and is treated as
 *    "no bounds filter" rather than "nothing is visible". Rendering an empty list for the
 *    first frame after load would be a lie.
 * 2. Distance is computed ONLY against a real reference point — the visitor's own fix.
 *    There is no city-centre fallback: `distanceMiles(null, …)` returns null and the row
 *    simply omits the distance rather than printing a number measured from somewhere the
 *    visitor is not.
 *
 * Public surface:
 *   useVisibleLocations(options): VisibleLocation[]
 *   type VisibleLocation
 */

import { useMemo } from 'react';
import type { LocationProperties } from '../types/location';
import type { LatLng } from '../lib/distance';
import { distanceMiles, formatDistance } from '../lib/distance';
import type { MapBounds } from '../lib/bounds';
import { boundsContain } from '../lib/bounds';
import type { Filters } from '../lib/filters';
import { applyFilters } from '../lib/filters';

export interface VisibleLocation {
  readonly location: LocationProperties;
  readonly coords: LatLng | null;
  /** `null` when there is no reference point. Never a centre-based guess. */
  readonly distance: string | null;
}

export interface UseVisibleLocationsOptions {
  readonly locations: readonly LocationProperties[];
  readonly coords: ReadonlyMap<string, LatLng>;
  readonly filters: Filters;
  readonly bounds: MapBounds | null;
  /** The visitor's position, or null. The only legal origin for a distance. */
  readonly origin: LatLng | null;
  /** Cap so a citywide view does not mount two thousand rows. Reachable via "Show more". */
  readonly limit?: number;
}

export const DEFAULT_VISIBLE_LIMIT = 60;

export function useVisibleLocations(
  options: UseVisibleLocationsOptions,
): VisibleLocation[] {
  const { locations, coords, filters, bounds, origin } = options;
  const limit = options.limit ?? DEFAULT_VISIBLE_LIMIT;

  return useMemo(() => {
    const matched = applyFilters(locations, filters);
    const visible: VisibleLocation[] = [];

    for (const location of matched) {
      const position = coords.get(location.id);
      // A location with no geometry cannot be on screen. The published artifact always has
      // one, but dropping the row beats showing a place the map cannot draw.
      if (position === undefined) continue;
      if (!boundsContain(bounds, position.lat, position.lng)) continue;
      visible.push({
        location,
        coords: position,
        distance: formatDistance(distanceMiles(origin, position)),
      });
    }

    visible.sort((a, b) => a.location.name.localeCompare(b.location.name, 'en'));
    return limit > 0 ? visible.slice(0, limit) : visible;
  }, [locations, coords, filters, bounds, origin, limit]);
}

/**
 * The untruncated count for the same predicate, so the bottom bar can say "60 of 1,432"
 * rather than pretending the cap is the whole dataset.
 */
export interface VisibleCountOptions {
  readonly locations: readonly LocationProperties[];
  readonly coords: ReadonlyMap<string, LatLng>;
  readonly filters: Filters;
  readonly bounds: MapBounds | null;
}

export function useVisibleCount(options: VisibleCountOptions): number {
  const { locations, coords, filters, bounds } = options;
  return useMemo(() => {
    const matched = applyFilters(locations, filters);
    let total = 0;
    for (const location of matched) {
      const position = coords.get(location.id);
      if (position === undefined) continue;
      if (!boundsContain(bounds, position.lat, position.lng)) continue;
      total += 1;
    }
    return total;
  }, [locations, coords, filters, bounds]);
}
