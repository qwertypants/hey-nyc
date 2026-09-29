/**
 * THE LIST, THE DETAIL AND THE EXTENT — Eat Outside's answers, in the registry's vocabulary.
 *
 * This is `src/hooks/useVisibleLocations.ts` and most of `src/components/DetailSheet.tsx`'s
 * data, restated as three pure functions. Two rules survive the move and both are about
 * honesty rather than layout:
 *
 *   1. `bounds === null` means "the map has not reported an extent yet", and is treated as
 *      "no extent filter" rather than "nothing is visible". An empty list for the first
 *      frame after load is a lie about the map, and it is the reason the loading card and
 *      the list are gated on `ready` at all.
 *   2. A distance is measured ONLY against a real reference point — the visitor's own fix.
 *      There is no city-centre fallback: `distanceMiles(null, …)` is null and the row
 *      simply omits the distance rather than printing a number measured from somewhere the
 *      visitor is not. Better absent than wrong.
 *
 * Rows are sorted by name, as they always were. A name is the one thing every place in this
 * dataset has, it is the only ordering that needs no invented ranking, and `AGENTS.md` rules
 * out a "best of" list.
 *
 * Public surface:
 *   type EatRowsInput, eatRows(input): FeatureRows
 *   eatDetail(location, metadata, origin): FeatureDetail
 *   eatExtent(input): MapBounds | null
 */

import type { DatasetMetadata, LocationProperties } from '../../types/location';
import type { LatLng } from '../../lib/distance';
import { distanceMiles, formatDistance } from '../../lib/distance';
import { boundsContain } from '../../lib/bounds';
import type { MapBounds } from '../../lib/bounds';
import { applyFilters, isFiltered } from '../../lib/filters';
import type { Filters } from '../../lib/filters';
import { describeType, typeStyle } from '../../map/style';
import {
  formatAddress,
  formatCityLine,
  formatLicensePeriod,
  formatLocality,
  formatUpdatedAt,
  formatDate,
  roadwaySeasonNote,
} from '../../lib/format';
import type { FeatureDetail, FeatureRow, FeatureRows, LatLngLike } from '../registry';

export interface EatRowsInput {
  readonly locations: readonly LocationProperties[];
  readonly coords: ReadonlyMap<string, LatLng>;
  readonly filters: Filters;
  readonly bounds: MapBounds | null;
  /** The visitor's own fix, or null. The only legal origin for a distance. */
  readonly origin: LatLngLike | null;
  /** Cap so a citywide view does not mount two thousand rows. */
  readonly limit: number;
}

interface Resolved {
  readonly location: LocationProperties;
  readonly position: LatLng;
}

function inView(input: EatRowsInput): Resolved[] {
  const matched = applyFilters(input.locations, input.filters);
  const resolved: Resolved[] = [];
  for (const location of matched) {
    const position = input.coords.get(location.id);
    // A location with no geometry cannot be on screen. The published artifact always has
    // one, but dropping the row beats showing a place the map cannot draw.
    if (position === undefined) continue;
    if (!boundsContain(input.bounds, position.lat, position.lng)) continue;
    resolved.push({ location, position });
  }
  resolved.sort((a, b) => a.location.name.localeCompare(b.location.name, 'en'));
  return resolved;
}

function toRow(entry: Resolved, origin: LatLngLike | null): FeatureRow {
  const { location, position } = entry;
  const style = typeStyle(location.type);
  return {
    id: location.id,
    title: location.name,
    subtitle: formatAddress(location),
    // Eat Outside has no per-place qualifier; the registry's `badge` is for a feature that
    // has one ("VERY BUSY", "RISING") and inventing a category here would be a claim the
    // dataset does not make.
    badge: null,
    lat: position.lat,
    lng: position.lng,
    meta: `${describeType(location.type)} · ${style.shapeDescription}`,
    symbol: style.shape,
    // Computed here rather than in the shell, because the shell must not know what a
    // distance is measured from. `formatDistance(null)` is null, so a row with no fix simply
    // has no distance and the shell omits the element.
    distance: formatDistance(distanceMiles(origin, position)),
  };
}

export function eatRows(input: EatRowsInput): FeatureRows {
  const resolved = inView(input);
  const page = input.limit > 0 ? resolved.slice(0, input.limit) : resolved;
  return {
    rows: page.map((entry) => toRow(entry, input.origin)),
    total: resolved.length,
    datasetCount: applyFilters(input.locations, input.filters).length,
    filtered: isFiltered(input.filters),
  };
}

/**
 * The bounding box of everything that matches, for the list's "zoom to all N places" and the
 * empty state's two ways out. `null` when there is nothing to frame, so the camera stays put
 * rather than being sent to a degenerate box.
 */
export function eatExtent(input: {
  readonly locations: readonly LocationProperties[];
  readonly coords: ReadonlyMap<string, LatLng>;
  readonly filters: Filters;
}): MapBounds | null {
  let west = Number.POSITIVE_INFINITY;
  let south = Number.POSITIVE_INFINITY;
  let east = Number.NEGATIVE_INFINITY;
  let north = Number.NEGATIVE_INFINITY;
  for (const location of applyFilters(input.locations, input.filters)) {
    const position = input.coords.get(location.id);
    if (position === undefined) continue;
    west = Math.min(west, position.lng);
    south = Math.min(south, position.lat);
    east = Math.max(east, position.lng);
    north = Math.max(north, position.lat);
  }
  if (!(north > south) || !(east > west)) return null;
  return { west, south, east, north };
}

/**
 * The registry's `FeatureDetail` for one place: pre-formatted strings and no formatting
 * anywhere else. Eat Outside does not render this — it brings its own sheet, because a
 * licence sheet is a type list, an address block, a seasonal note and a directions link, and
 * flattening that into label/value rows would lose the shape the source has. It is
 * implemented anyway because it is the contract, and because it is what a second consumer of
 * the same data would read.
 */
export function eatDetail(
  location: LocationProperties,
  coords: ReadonlyMap<string, LatLng>,
  metadata: DatasetMetadata | null,
  origin: LatLngLike | null,
): FeatureDetail {
  const style = typeStyle(location.type);
  const season = roadwaySeasonNote(location.type);
  const position = coords.get(location.id) ?? null;
  // A distance with nothing to measure from is absent, not zero: `distanceMiles` returns
  // null for a null origin, and the shell omits the element rather than printing a number
  // measured from somewhere the visitor is not.
  const distance = position === null ? null : formatDistance(distanceMiles(origin, position));
  const distanceLine = distance === null ? null : `${distance} from you`;
  const updatedAt = formatUpdatedAt(metadata);

  const facts = [
    { label: 'Address', value: `${formatLocality(location)}, ${formatCityLine(location)}` },
    { label: 'Dining type', value: `${describeType(location.type)} — ${style.shapeDescription}` },
    { label: 'Licence', value: formatLicensePeriod(location) },
    { label: 'Status', value: location.status },
  ];
  const issued = formatDate(location.licenseIssued);
  if (issued !== null) facts.push({ label: 'Issued', value: issued });
  if (updatedAt !== null) facts.push({ label: 'Data', value: updatedAt });

  return {
    title: location.name,
    headline: describeType(location.type),
    facts,
    caveat: season ?? distanceLine,
  };
}
