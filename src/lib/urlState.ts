/**
 * INTEGRATION NOTES (src/lib/urlState.ts)
 *
 * Total, throw-free translation between the URL query string and the map view. Stream C
 * should call `parseUrlState(window.location.search)` once on first render and
 * `serializeUrlState(state)` on every change (debounced, via `history.replaceState`).
 *
 * Public surface:
 *   MIN_ZOOM, MAX_ZOOM, DEFAULT_VIEW, VIEW_LIMITS
 *   DEFAULT_FEATURE_ID, type MapView, type UrlState
 *   isValidLocationId, isFeatureId, readMode, parseUrlState, serializeUrlState
 *   clampView, roundView, sameView, isDefaultView
 *
 * Guarantees:
 * - Nothing here throws, for any input. Malformed, missing, hostile and out-of-range
 *   values all resolve to a safe default.
 * - Coordinates are rounded to 5 decimal places (~1 m) and zoom to 2, so two people
 *   sharing a link see the same view and the query string stays short.
 * - The serialiser emits a fixed key order and omits defaults, so
 *   `serializeUrlState(parseUrlState(x))` is idempotent and byte-stable.
 * - There is deliberately no parameter, field or key for a visitor's own geolocation.
 *   A shared link describes a map view only; see `Privacy` in the module note below.
 *
 * Privacy: `UrlState` has no member that can hold a user position, and
 * `serializeUrlState` writes only the seven whitelisted keys below. A geolocation fix is
 * applied to the map instance, never round-tripped through the URL.
 *
 * `mode` — WHICH FEATURE. See `src/features/registry.ts`: a feature's id is its URL slug,
 * so `?mode=walk` and `?mode=eat` are the only two the app advertises. It is first in the
 * key order and, like every other key here, is omitted at its default, so a shared link to
 * the default feature carries no `mode` at all and the canonical empty query string is
 * still `''`.
 */

import { isBoroughFilter, isTypeFilter, NO_FILTER } from './filters';
import type { BoroughFilter, Filters, TypeFilter } from './filters';
import type { FeatureId } from '../features/registry';

export interface MapView {
  readonly lng: number;
  readonly lat: number;
  readonly zoom: number;
}

export interface UrlState {
  /** Which feature the link is about. Never absent — an unknown slug resolves to this. */
  readonly mode: FeatureId;
  readonly view: MapView;
  readonly filters: Filters;
  readonly selectedId: string | null;
}

/**
 * The feature a bare link opens. It is the site's own name, and it is the only feature the
 * app has always had, so a link that predates `mode` must keep meaning what it meant.
 */
export const DEFAULT_FEATURE_ID: FeatureId = 'eat';

/**
 * Every slug the app advertises, in the order the switcher shows them. A `?mode=` carrying
 * anything else is not a feature — it is a typo or a hand-edited link, and it resolves to
 * the default rather than to a blank screen.
 */
const FEATURE_IDS: readonly FeatureId[] = ['eat', 'walk'];

export function isFeatureId(value: unknown): value is FeatureId {
  return typeof value === 'string' && (FEATURE_IDS as readonly string[]).includes(value);
}

/**
 * `readMode` is the ONE place that decides what an absent or unknown `?mode=` means, and
 * `src/features/registry.ts` points at it by name for that reason. It is a function rather
 * than a lookup at the parse site so that the rule cannot be re-implemented — by a feature
 * module, by a test, or by the next person to add a third feature.
 */
export function readMode(raw: string | null | undefined): FeatureId {
  return isFeatureId(raw) ? raw : DEFAULT_FEATURE_ID;
}

/**
 * The fallback citywide view, used when a shared link carries no usable view parameters.
 *
 * The centre is the centroid of the PUBLISHED DATA (measured 2026-09-27 across all 2 000
 * features), not the centroid of the city's land area. The borough centroid sits west of
 * the data centroid, which is what put New Jersey in the opening frame on a phone.
 *
 * This is a fallback, not the opening view: `fitViewFor` in `src/lib/viewport.ts` derives
 * the real initial view from the actual viewport, because no single constant can frame NYC
 * correctly on both a 390px phone and a 1440px desktop. The controller uses this constant
 * only to recognise "the link did not specify a view".
 */
export const DEFAULT_VIEW: MapView = { lng: -73.9319, lat: 40.742, zoom: 10.6 };

/** Matches the map's own camera limits; a link can never place the map outside them. */
export const VIEW_LIMITS = {
  minLat: 40.35,
  maxLat: 41.1,
  minLng: -74.35,
  maxLng: -73.65,
  minZoom: 9,
  maxZoom: 16,
} as const;

export const MIN_ZOOM = VIEW_LIMITS.minZoom;
export const MAX_ZOOM = VIEW_LIMITS.maxZoom;

/** One metre-ish at NYC latitudes, chosen so shared links are stable. */
const COORDINATE_PRECISION = 5;
const ZOOM_PRECISION = 2;

/** Longer than this is a hostile or corrupted link, not a coordinate. */
const MAX_PARAM_LENGTH = 64;

/** `eoy-` + 12 lowercase hex, exactly as the data pipeline produces (see docs/data-dictionary.md §5). */
const LOCATION_ID_PATTERN = /^eoy-[0-9a-f]{12}$/;

export function isValidLocationId(value: unknown): value is string {
  return typeof value === 'string' && value.length <= MAX_PARAM_LENGTH &&
    LOCATION_ID_PATTERN.test(value);
}

function roundTo(value: number, precision: number): number {
  const factor = 10 ** precision;
  return Math.round(value * factor) / factor;
}

function clamp(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

function isUsableNumber(value: number): boolean {
  return Number.isFinite(value);
}

/**
 * Coerces any candidate into a legal camera position. This is the ONLY place a view is
 * validated, so the map, the URL and the camera can never disagree about what is legal.
 */
export function clampView(candidate: unknown): MapView {
  if (typeof candidate !== 'object' || candidate === null) return DEFAULT_VIEW;
  const raw = candidate as { lng?: unknown; lat?: unknown; zoom?: unknown };

  const lat = typeof raw.lat === 'number' && isUsableNumber(raw.lat) ? raw.lat : DEFAULT_VIEW.lat;
  const lng = typeof raw.lng === 'number' && isUsableNumber(raw.lng) ? raw.lng : DEFAULT_VIEW.lng;
  const zoom = typeof raw.zoom === 'number' && isUsableNumber(raw.zoom) ? raw.zoom : DEFAULT_VIEW.zoom;

  return roundView({
    lat: clamp(lat, VIEW_LIMITS.minLat, VIEW_LIMITS.maxLat),
    lng: clamp(lng, VIEW_LIMITS.minLng, VIEW_LIMITS.maxLng),
    zoom: clamp(zoom, MIN_ZOOM, MAX_ZOOM),
  });
}

export function roundView(view: MapView): MapView {
  return {
    lat: roundTo(view.lat, COORDINATE_PRECISION),
    lng: roundTo(view.lng, COORDINATE_PRECISION),
    zoom: roundTo(view.zoom, ZOOM_PRECISION),
  };
}

export function sameView(a: MapView, b: MapView): boolean {
  return a.lat === b.lat && a.lng === b.lng && a.zoom === b.zoom;
}

export function isDefaultView(view: MapView): boolean {
  return sameView(view, DEFAULT_VIEW);
}

/**
 * Reads a raw query string. Accepts with or without the leading `?`.
 *
 * Duplicate keys: the FIRST occurrence wins, matching `URLSearchParams.get` and
 * `?lat=1&lat=2` therefore resolving to 1. Over-long values are discarded rather than
 * parsed, so a megabyte-long `?z=…` costs nothing.
 */
export function parseUrlState(search: string): UrlState {
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(typeof search === 'string' ? search : '');
  } catch {
    return { mode: DEFAULT_FEATURE_ID, view: DEFAULT_VIEW, filters: NO_FILTER, selectedId: null };
  }

  const read = (key: string): string | null => {
    const value = params.get(key);
    if (value === null) return null;
    return value.length <= MAX_PARAM_LENGTH ? value : null;
  };

  const toNumber = (raw: string | null): number | null => {
    if (raw === null || raw.trim() === '') return null;
    // Number('') is 0 and Number('12px') is NaN; Number('Infinity') is Infinity.
    const value = Number(raw);
    return isUsableNumber(value) ? value : null;
  };

  const rawType = read('type');
  const rawBorough = read('borough');
  const rawSelected = read('sel');

  const type: TypeFilter = isTypeFilter(rawType) ? rawType : 'all';
  const borough: BoroughFilter = isBoroughFilter(rawBorough) ? rawBorough : 'all';

  const lat = toNumber(read('lat'));
  const lng = toNumber(read('lng'));
  const zoom = toNumber(read('z'));

  const view = roundView({
    lat: lat === null ? DEFAULT_VIEW.lat : clamp(lat, VIEW_LIMITS.minLat, VIEW_LIMITS.maxLat),
    lng: lng === null ? DEFAULT_VIEW.lng : clamp(lng, VIEW_LIMITS.minLng, VIEW_LIMITS.maxLng),
    zoom: zoom === null ? DEFAULT_VIEW.zoom : clamp(zoom, MIN_ZOOM, MAX_ZOOM),
  });

  return {
    mode: readMode(read('mode')),
    view,
    filters: { type, borough },
    selectedId: isValidLocationId(rawSelected) ? rawSelected : null,
  };
}

/**
 * Canonical query string, `?`-prefixed, or `''` when everything is at its default.
 * Only these seven keys are ever written, in this order: mode, lat, lng, z, type,
 * borough, sel.
 */
export function serializeUrlState(state: UrlState): string {
  const view = clampView(state.view);
  const filters: Filters = {
    type: isTypeFilter(state.filters?.type) ? state.filters.type : 'all',
    borough: isBoroughFilter(state.filters?.borough) ? state.filters.borough : 'all',
  };
  const selectedId = isValidLocationId(state.selectedId) ? state.selectedId : null;
  // `state.mode` is a required member of the type and is still checked: this function is
  // documented as never throwing for ANY input, and the hostile-input case in
  // tests/url-state.test.ts hands it an object with no `mode` at all.
  const mode = isFeatureId(state.mode) ? state.mode : DEFAULT_FEATURE_ID;

  const params = new URLSearchParams();
  // First, and omitted at its default — the same rule every other key follows, which is why
  // the canonical link for "the whole city, no filters, default feature" is still empty.
  if (mode !== DEFAULT_FEATURE_ID) params.set('mode', mode);
  if (!isDefaultView(view)) {
    params.set('lat', String(view.lat));
    params.set('lng', String(view.lng));
    params.set('z', String(view.zoom));
  }
  if (filters.type !== 'all') params.set('type', filters.type);
  if (filters.borough !== 'all') params.set('borough', filters.borough);
  if (selectedId !== null) params.set('sel', selectedId);

  const query = params.toString();
  return query === '' ? '' : `?${query}`;
}

/** Narrow helper for a single dimension, used by the shell's filter controls. */
export function urlStateWithFilters(state: UrlState, filters: Filters): UrlState {
  return { mode: state.mode, view: state.view, filters, selectedId: state.selectedId };
}

/** Narrow helper: the view alone, with mode, filters and selection preserved. */
export function urlStateWithView(state: UrlState, view: MapView): UrlState {
  return {
    mode: state.mode,
    view: clampView(view),
    filters: state.filters,
    selectedId: state.selectedId,
  };
}
