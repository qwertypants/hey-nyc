/**
 * INTEGRATION NOTES (src/features/walk/rows.ts)
 *
 * The list, and the three ways of ordering it. "Most active" is a claim; this file is where
 * each claim is stated, implemented, and exported as text the UI can print.
 *
 * WHAT IS IN THE LIST
 * -------------------
 * The 114 manual survey sites, plus the 4 automated counters at the end. The two are never
 * ranked against each other, because they are not comparable: a survey total is three
 * periods of one afternoon and a counter total is fifteen minutes at one hour. Sorting a
 * counter among survey sites by a number would put two different measurements on one scale
 * and invite exactly the comparison `src/types/walk.ts` forbids.
 *
 * So: the two metric sorts (`mostSurveyed`, `mostChanged`) order the SURVEY SITES among
 * themselves and pin every counter to the end, where they are still reachable and still get a
 * detail sheet. The pinned counters are ordered by `id` rather than left in whatever order
 * they arrived in, because a sort that reshuffles its tail when the input is shuffled is not
 * total and a list that reshuffles under the pointer is a bug nobody can report precisely.
 * `nearby` is the one sort both kinds participate in, because a distance is a distance.
 *
 * THE THREE DEFINITIONS
 * ---------------------
 *   mostSurveyed  the `total` of the site's MOST RECENT survey, largest first.
 *                 Not the site's all-time maximum, and not a running average: `total` is
 *                 defined by the contract as the am + md + pm of the latest survey, and the
 *                 most recent survey is the one a visitor standing there would recognise.
 *                 A site with no survey at all sorts last, because it has nothing to rank.
 *
 *   mostChanged   the ABSOLUTE magnitude of the signed `change` between the site's first
 *                 and most recent complete surveys, largest first.
 *
 *                 ABSOLUTE, deliberately, and it is the one place in this file where a
 *                 defensible choice was made between two readings of the same word. The
 *                 contract's `change` is signed: 41 of the 114 published sites are falling
 *                 and 41 are rising, almost exactly evenly. A "biggest rise" sort would
 *                 therefore show a third of the city and hide the other half; a "biggest
 *                 fall" sort would show the other half. What a visitor asking this question
 *                 wants is "where has foot traffic changed most" — a place that emptied out
 *                 is as much an answer as a place that filled up, and often a more useful
 *                 one. So the badge on the row still says RISING or FALLING, the detail
 *                 sheet still gives the signed number, and only the ORDER is by magnitude.
 *
 *   nearby        great-circle distance from the visitor's position, nearest first. Offered
 *                 ONLY when there is a position. With no position this returns NOTHING —
 *                 not all 114 in an arbitrary order — because a list headed "nearby" that
 *                 is not sorted by distance is a lie about its own heading, and the app's
 *                 standing rule is that no distance is shown without a real fix to measure
 *                 from. The shell reads `nearbyNeedsPosition` to decide whether to offer the
 *                 control at all.
 *
 * `null` as the sort — the shell has not chosen one — is the DATASET ORDER: the order the
 * pipeline published, survey sites then counters. It makes no claim at all, which is the
 * right default before a visitor has expressed a preference.
 *
 * STABILITY. Every comparator ends in a comparison on `id`, so the order is TOTAL. Two sites
 * with the same total come out in the same order on every render, on every machine, and the
 * list does not shuffle under the pointer. Relying on `Array.prototype.sort` being stable
 * would leave the tie broken by whatever order the array happened to arrive in, which is
 * stable but arbitrary — arbitrary is a word nobody wants in a sort.
 *
 * THE FEATURE'S OWN DEFAULT IS NOT THE DATASET ORDER
 * -------------------------------------------------
 * `buildListRows` is the ordering PRIMITIVE and it keeps the meaning above. `walkRows` below
 * is the registry's `rows(query)`, and it maps "the shell has not chosen a sort" onto
 * `WALK_DEFAULT_SORT` instead. It has to, because the sort control this feature supplies
 * shows `Busiest at the last survey` as selected when the shell has not chosen one
 * (`tests/walk-a11y.test.tsx` pins that), and a control that describes an order the list is
 * not in is the same class of lie as a "nearby" list that is not sorted by distance.
 *
 * Public surface:
 *   WALK_SORT_OPTIONS, WALK_DEFAULT_SORT, WalkSortOption, sortDefinition, sortLabel
 *   isWalkSort, buildListRows, listRowFor
 *   walkRows(input), walkExtent(index)
 */

import type { FeatureRow, FeatureRows, WalkSort } from '../registry';
import type { MapBounds } from '../../lib/bounds';
import { boundsContain } from '../../lib/bounds';
import type { LatLng } from '../../lib/distance';
import { distanceMiles, formatDistance } from '../../lib/distance';
import type { WalkIndex, WalkItem } from '../../data/walk/validate';
import { displaySensor } from './display';
import type { DisplaySensor } from './display';
import { ACTIVITY_STYLES, TREND_STYLES } from './style';
import {
  sensorSubtitle,
  stalenessBadge,
  surveySubtitle,
  trendBadge,
} from './wording';

/** The order the list is in before the visitor has asked for one. */
export const WALK_DEFAULT_SORT: WalkSort = 'mostSurveyed';

/** One sort, as the UI states it. The definition is shown, not hidden behind a tooltip. */
export interface WalkSortOption {
  readonly id: WalkSort;
  /** The control's own label. */
  readonly label: string;
  /**
   * What the sort MEANS, in one sentence, printed under the control. A sort nobody can
   * define is a sort nobody should be able to press.
   */
  readonly definition: string;
  /** True when the sort cannot answer without a visitor position. */
  readonly needsPosition: boolean;
}

export const WALK_SORT_OPTIONS: readonly WalkSortOption[] = [
  {
    id: 'mostSurveyed',
    label: 'Busiest at the last survey',
    definition:
      'The pedestrian total of each site’s most recent manual survey, largest first. One afternoon, counted by hand.',
    needsPosition: false,
  },
  {
    id: 'mostChanged',
    label: 'Changed the most',
    definition:
      'The largest absolute change in the total since the site’s first survey, whichever direction. A big fall counts the same as a big rise.',
    needsPosition: false,
  },
  {
    id: 'nearby',
    label: 'Nearest to you',
    definition: 'Straight-line distance from your position, nearest first. Shown only when the app has one.',
    needsPosition: true,
  },
];

export function sortLabel(sort: WalkSort): string {
  return WALK_SORT_OPTIONS.find((option) => option.id === sort)?.label ?? '';
}

export function sortDefinition(sort: WalkSort): string {
  return WALK_SORT_OPTIONS.find((option) => option.id === sort)?.definition ?? '';
}

export function isWalkSort(value: unknown): value is WalkSort {
  return WALK_SORT_OPTIONS.some((option) => option.id === value);
}

/**
 * The metric a survey site is ranked by, or null when it has nothing to rank. `null` sorts
 * LAST under every metric, which is the only honest placement: a site with no survey is not
 * the quietest site, it is an unmeasured one.
 */
function surveyMetric(item: WalkItem, sort: WalkSort): number | null {
  if (item.kind !== 'historical') return null;
  if (sort === 'mostSurveyed') return item.properties.total;
  if (sort === 'mostChanged') {
    return item.properties.change === null ? null : Math.abs(item.properties.change);
  }
  return null;
}

/** Longest record first, as the tie-break: a 20-year comparison beats a 5-year one. */
function tieBreakDepth(item: WalkItem): number {
  return item.kind === 'historical' ? item.properties.yearsMeasured : -1;
}

function byId(a: WalkItem, b: WalkItem): number {
  if (a.properties.id === b.properties.id) return 0;
  return a.properties.id < b.properties.id ? -1 : 1;
}

function compareForMetric(sort: Exclude<WalkSort, 'nearby'>): (a: WalkItem, b: WalkItem) => number {
  return (a, b) => {
    const left = surveyMetric(a, sort);
    const right = surveyMetric(b, sort);
    if (left === null && right === null) return byId(a, b);
    // Nulls last, in both directions: `right === null` also returns 1.
    if (left === null) return 1;
    if (right === null) return -1;
    if (left !== right) return right - left;

    const depth = tieBreakDepth(b) - tieBreakDepth(a);
    if (depth !== 0) return depth;
    return byId(a, b);
  };
}

function compareByDistance(origin: LatLng): (a: WalkItem, b: WalkItem) => number {
  return (a, b) => {
    const left = distanceMiles(origin, a.coords);
    const right = distanceMiles(origin, b.coords);
    // Both points are finite, so a null distance here would be a bug rather than a state.
    if (left === null || right === null) return byId(a, b);
    if (left !== right) return left - right;
    return byId(a, b);
  };
}

/**
 * The counters, always last under a metric sort, and ordered by `id` among themselves so the
 * whole order is total. See the module header.
 */
function sensorItems(items: readonly WalkItem[]): WalkItem[] {
  return items.filter((item) => item.kind === 'sensor').sort(byId);
}

function surveyItems(items: readonly WalkItem[]): WalkItem[] {
  return items.filter((item) => item.kind === 'historical');
}

/**
 * The bare row for one item: an id, a title, a subtitle, a badge and a position. The
 * registry's `FeatureRow` is this plus `meta`, `symbol` and `distance`, and `walkRows` adds
 * those — see `toFeatureRow`. Exported so a test can assert a row without a sort.
 */
export interface ListRow {
  readonly id: string;
  readonly title: string;
  readonly subtitle: string;
  readonly badge: string | null;
  readonly lat: number;
  readonly lng: number;
}

export function listRowFor(item: WalkItem, now: number, origin: LatLng | null): ListRow {
  // A distance is shown whenever there is a real position to measure from, and never
  // otherwise — the shell's own rule, and the reason `formatDistance` returns null rather
  // than a guess. The same `formatDistance` the rest of the app uses, so the miles/feet
  // switchover happens at the same number in both features.
  const miles = origin === null ? null : distanceMiles(origin, item.coords);
  const distance = formatDistance(miles);

  const parts = (base: string): string =>
    distance === null ? base : `${distance} away · ${base}`;

  if (item.kind === 'historical') {
    return {
      id: item.properties.id,
      title: item.properties.name,
      subtitle: parts(surveySubtitle(item.properties)),
      badge: trendBadge(item.properties.trend).toUpperCase(),
      lat: item.coords.lat,
      lng: item.coords.lng,
    };
  }

  const display: DisplaySensor = displaySensor(item.properties, null);
  return {
    id: item.properties.id,
    title: item.properties.name,
    subtitle: parts(sensorSubtitle(display, now)),
    badge: stalenessBadge(item.properties.staleness).toUpperCase(),
    lat: item.coords.lat,
    lng: item.coords.lng,
  };
}

/**
 * The rows for the current sort. See the module header for every definition; the sort is
 * TOTAL, so the same input always produces the same output.
 */
export function buildListRows(
  items: readonly WalkItem[],
  sort: WalkSort | null,
  origin: LatLng | null,
  now: number,
): readonly ListRow[] {
  // No position means no `nearby` list at all, and no counters either: a list with nothing
  // sorted by distance in it is not a nearby list.
  if (sort === 'nearby' && origin === null) return [];

  const ordered: WalkItem[] =
    sort === null
      ? [...items]
      : sort === 'nearby'
        ? origin === null
          ? []
          : [...items].sort(compareByDistance(origin))
        : [...surveyItems(items)].sort(compareForMetric(sort)).concat(sensorItems(items));

  return ordered.map((item) => listRowFor(item, now, origin));
}

// ---------------------------------------------------------------------------
// The registry's `rows(query)`, `extent(query)` and the row the shell renders.
// ---------------------------------------------------------------------------

export interface WalkRowsInput {
  readonly index: WalkIndex;
  /** The visitor's own fix, or null. The only legal origin for a distance. */
  readonly origin: LatLng | null;
  /** The shell's order, or `null` for this feature's default. See the module header. */
  readonly sort: WalkSort | null;
  /** The page cap. */
  readonly limit: number;
  /**
   * The map's visible extent, or null before the map has reported one. Null means NO extent
   * filter, never "nothing is visible" — the same rule the eat list follows, and for the same
   * reason: an empty list for the first frame after a load is a lie about the map.
   */
  readonly bounds: MapBounds | null;
  readonly now: number;
}

/**
 * The shape the map actually paints, in words.
 *
 * This is the third channel, and for walk it is the only one the LIST can carry. The row's
 * `symbol` is `null` because the shell's swatch vocabulary is Eat Outside's three CSS shapes
 * and walk's are a heavy-rimmed disc, a wide disc, a faint disc and a hollow ring with an
 * `x` — a class suffix the shell's stylesheet has never heard of, and rendering it would
 * produce an invisible dot. So the words go in `meta` and the glyph goes in walk's own
 * legend, which is why the feature brings its own.
 */
function shapeWords(item: WalkItem): string {
  if (item.kind === 'historical') return TREND_STYLES[item.properties.trend].shapeDescription;
  return ACTIVITY_STYLES[displaySensor(item.properties, null).activity].shapeDescription;
}

/**
 * One `FeatureRow` for one `ListRow`.
 *
 * `distance` is `null` on purpose and NOT because there is no fix: `listRowFor` puts the
 * distance in the FRONT of the subtitle ("1,200 ft away · Surveyed May 2026") and that is
 * where it belongs, next to the claim the sort is making. A second element printing it would
 * be the same distance twice.
 */
function toFeatureRow(row: ListRow, item: WalkItem): FeatureRow {
  return { ...row, meta: shapeWords(item), symbol: null, distance: null };
}

function inView(items: readonly WalkItem[], bounds: MapBounds | null): readonly WalkItem[] {
  if (bounds === null) return items;
  return items.filter((item) => boundsContain(bounds, item.coords.lat, item.coords.lng));
}

const NO_ROWS: FeatureRows = { rows: [], total: 0, datasetCount: 0, filtered: false };

/**
 * The list, and the counts the shell needs to be honest about it.
 *
 * `datasetCount` is the whole index and `filtered` is always `false`, because this feature
 * has no dimensions to filter by — it says so with `controls.filters === null`, and the
 * shell writes `NO_FILTER` into the link on its behalf. Returning `filtered: true` here
 * would put "Clear filters" on a map with no filters, and a button that clears nothing.
 */
export function walkRows(input: WalkRowsInput): FeatureRows {
  const inBounds = inView(input.index.items, input.bounds);
  if (inBounds.length === 0) {
    return { ...NO_ROWS, datasetCount: input.index.items.length };
  }

  const origin = input.origin;
  const sort = input.sort ?? WALK_DEFAULT_SORT;
  const ordered = buildListRows(inBounds, sort, origin, input.now);
  const byId = input.index.byId;
  const rows: FeatureRow[] = [];
  for (const row of ordered) {
    const item = byId.get(row.id);
    // `buildListRows` is total over the items it was handed and every one of them came out
    // of the index, so this always resolves. A row with no item is a row the map cannot
    // draw, and the list exists to be the alternative to the map.
    if (item === undefined) continue;
    rows.push(toFeatureRow(row, item));
  }

  return {
    rows: input.limit > 0 ? rows.slice(0, input.limit) : rows,
    total: ordered.length,
    datasetCount: input.index.items.length,
    filtered: false,
  };
}

/**
 * The bounding box of every measurement point, for the empty state's "zoom to all N count
 * sites". `null` when there is nothing to frame, so the camera stays put rather than being
 * sent to a degenerate box.
 */
export function walkExtent(index: WalkIndex): MapBounds | null {
  let west = Number.POSITIVE_INFINITY;
  let south = Number.POSITIVE_INFINITY;
  let east = Number.NEGATIVE_INFINITY;
  let north = Number.NEGATIVE_INFINITY;
  for (const item of index.items) {
    west = Math.min(west, item.coords.lng);
    south = Math.min(south, item.coords.lat);
    east = Math.max(east, item.coords.lng);
    north = Math.max(north, item.coords.lat);
  }
  if (!(north > south) || !(east > west)) return null;
  return { west, south, east, north };
}

