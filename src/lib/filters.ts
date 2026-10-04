/**
 * INTEGRATION NOTES (src/lib/filters.ts)
 *
 * The single definition of what a filter IS. `src/lib/urlState.ts`, `src/map/layers.ts`
 * (as MapLibre `setFilter` expressions) and Stream C's filter UI all read these types and
 * helpers, so the URL, the map and the list can never disagree about what is selected.
 *
 * A filter value of `'all'` means "no constraint on this dimension". It is deliberately
 * distinct from any real `DiningType` / `Borough` so `'all'` can be omitted from the URL.
 *
 * Public surface:
 *   type TypeFilter, type BoroughFilter, interface Filters
 *   NO_FILTER, isFiltered, normalizeFilters
 *   matchesType, matchesBorough, matchesFilters, applyFilters
 *   countByType, countByBorough, countFor
 *   typeOptions, boroughOptions
 */

import { BOROUGHS, DINING_TYPES } from '../types/location';
import type { Borough, DiningType, LocationProperties } from '../types/location';

export type TypeFilter = DiningType | 'all';
export type BoroughFilter = Borough | 'all';

export interface Filters {
  readonly type: TypeFilter;
  readonly borough: BoroughFilter;
  /** Storefront-only dimensions; omitted by Eat and Walk. */
  readonly status?: 'vacant' | 'nonVacant' | 'both';
  readonly year?: string;
  readonly construction?: 'any' | 'reported' | 'notReported' | 'unknown';
}

export const NO_FILTER: Filters = { type: 'all', borough: 'all' };

const TYPE_SET: ReadonlySet<string> = new Set<string>(DINING_TYPES);
const BOROUGH_SET: ReadonlySet<string> = new Set<string>(BOROUGHS);

export function isTypeFilter(value: unknown): value is TypeFilter {
  return typeof value === 'string' && (value === 'all' || TYPE_SET.has(value));
}

export function isBoroughFilter(value: unknown): value is BoroughFilter {
  return typeof value === 'string' && (value === 'all' || BOROUGH_SET.has(value));
}

/** Coerces anything into a valid `Filters`. Never throws. */
export function normalizeFilters(candidate: unknown): Filters {
  if (typeof candidate !== 'object' || candidate === null) return NO_FILTER;
  const raw = candidate as { type?: unknown; borough?: unknown };
  return {
    type: isTypeFilter(raw.type) ? raw.type : 'all',
    borough: isBoroughFilter(raw.borough) ? raw.borough : 'all',
  };
}

export function isFiltered(filters: Filters): boolean {
  return filters.type !== 'all' || filters.borough !== 'all';
}

export function matchesType(properties: LocationProperties, filter: TypeFilter): boolean {
  return filter === 'all' || properties.type === filter;
}

export function matchesBorough(
  properties: LocationProperties,
  filter: BoroughFilter,
): boolean {
  return filter === 'all' || properties.borough === filter;
}

export function matchesFilters(
  properties: LocationProperties,
  filters: Filters,
): boolean {
  return matchesType(properties, filters.type) && matchesBorough(properties, filters.borough);
}

export function applyFilters(
  locations: readonly LocationProperties[],
  filters: Filters,
): LocationProperties[] {
  if (!isFiltered(filters)) return locations.slice();
  return locations.filter((location) => matchesFilters(location, filters));
}

export function countByType(
  locations: readonly LocationProperties[],
): Record<DiningType, number> {
  const counts: Record<DiningType, number> = { sidewalk: 0, roadway: 0, both: 0 };
  for (const location of locations) counts[location.type] += 1;
  return counts;
}

export function countByBorough(
  locations: readonly LocationProperties[],
): Record<Borough, number> {
  const counts = {} as Record<Borough, number>;
  for (const borough of BOROUGHS) counts[borough] = 0;
  for (const location of locations) counts[location.borough] += 1;
  return counts;
}

/**
 * How many locations a candidate filter would yield, without materialising the list.
 * Used for the counts beside each filter control.
 */
export function countFor(
  locations: readonly LocationProperties[],
  filters: Filters,
): number {
  if (!isFiltered(filters)) return locations.length;
  let total = 0;
  for (const location of locations) if (matchesFilters(location, filters)) total += 1;
  return total;
}

export interface FilterOption<TValue extends string> {
  readonly value: TValue;
  /** Human label. Type wording comes from `src/map/style.ts` so it is never re-invented. */
  readonly label: string;
  readonly count: number;
  /** True when the currently active filter would yield zero locations for this option. */
  readonly empty: boolean;
}

/**
 * Type filter options in canonical order. The label for each type is supplied by the
 * caller (or `src/map/style.ts`) so the vocabulary lives in one place.
 */
export function typeOptions(
  locations: readonly LocationProperties[],
  current: Filters,
  describe: (type: DiningType) => string,
): Array<FilterOption<TypeFilter>> {
  const values: TypeFilter[] = ['all', ...DINING_TYPES];
  return values.map((value) => {
    const count = countFor(locations, { type: value, borough: current.borough });
    return {
      value,
      label: value === 'all' ? `All (${locations.length.toLocaleString('en-US')})` : describe(value),
      count,
      empty: count === 0,
    };
  });
}

export function boroughOptions(
  locations: readonly LocationProperties[],
  current: Filters,
): Array<FilterOption<BoroughFilter>> {
  const values: BoroughFilter[] = ['all', ...BOROUGHS];
  return values.map((value) => {
    const count = countFor(locations, { type: current.type, borough: value });
    return {
      value,
      label: value === 'all' ? `All (${locations.length.toLocaleString('en-US')})` : value,
      count,
      empty: count === 0,
    };
  });
}
