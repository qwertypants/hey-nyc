/**
 * INTEGRATION NOTES (src/map/createMap.ts)
 *
 * Constructs the ONE MapLibre instance. Exactly one is created for the lifetime of the app
 * and owned by `src/map/controller.ts`; React never holds it in state.
 *
 * Public surface:
 *   NYC_CENTER, NYC_ZOOM, NYC_MAX_ZOOM, NYC_MIN_ZOOM, ATTRIBUTION_CONTROL_OPTIONS
 *   basemapStyleUrl(): string
 *   createMap(options: CreateMapOptions): Map
 *   type CreateMapOptions
 *
 * Hard requirements implemented here:
 * - OpenFreeMap `positron` by default; `VITE_BASEMAP_STYLE_URL` is the single seam for
 *   self-hosting (docs/basemap.md). The style is referenced by URL, never inlined, so the
 *   basemap's own attribution keeps flowing through automatically.
 * - `attributionControl` on, with a `customAttribution` string crediting NYC Open Data /
 *   NYC DOT, in addition to the basemap credit MapLibre reads from the TileJSON.
 * - `maxZoom: 16`. The basemap TileJSON is maxzoom 14, so anything past that is overzoomed
 *   raster and looks worse than being unable to reach it.
 * - NO geolocation is requested here. `locateUser()` is a separate, explicit call.
 *
  * The `center`/`zoom` defaults here are only a last-resort fallback. The real opening
  * view is computed per viewport by `fitViewFor` in `src/lib/viewport.ts` and passed in by
  * the controller, because NYC is 0.42° wide and 0.34° tall while a phone in portrait is
  * roughly 1:1.8 — no single constant frames it correctly on both. The constant is the
  * centroid of the published data, not of the boroughs: the borough centroid sits west of
  * it, which put Hoboken and Jersey City in the opening frame on a phone.
  */

import maplibregl from 'maplibre-gl';
import type { Map as MapLibreMap, MapOptions } from 'maplibre-gl';
import { DATA_ATTRIBUTION_HTML } from '../lib/attribution';
import { DEFAULT_VIEW, MAX_ZOOM, MIN_ZOOM } from '../lib/urlState';

export const NYC_CENTER: [number, number] = [DEFAULT_VIEW.lng, DEFAULT_VIEW.lat];
export const NYC_ZOOM = DEFAULT_VIEW.zoom;

export const NYC_MIN_ZOOM = MIN_ZOOM;
export const NYC_MAX_ZOOM = MAX_ZOOM;

export const DEFAULT_STYLE_URL = 'https://tiles.openfreemap.org/styles/positron';

/**
 * `compact: false` on purpose: the docs for `AttributionControlOptions` warn that
 * collapsing attribution is only acceptable when the credits cannot fit, and we carry two
 * independent credits (OpenStreetMap via the basemap, NYC DOT from us).
 */
export const ATTRIBUTION_CONTROL_OPTIONS = {
  compact: false,
  customAttribution: DATA_ATTRIBUTION_HTML,
} as const;

export function basemapStyleUrl(): string {
  const override = import.meta.env?.VITE_BASEMAP_STYLE_URL;
  return typeof override === 'string' && override.trim().length > 0 ? override : DEFAULT_STYLE_URL;
}

export interface CreateMapOptions {
  readonly container: HTMLElement;
  /** Overrides the NYC citywide start view, e.g. from a shared URL. */
  readonly center?: [number, number];
  readonly zoom?: number;
  /** MapLibre's own error reporting; the app turns these into an error state. */
  readonly onError?: (error: Error) => void;
  /** Fired when the style has loaded and layers may be added. */
  readonly onStyleLoad?: (map: MapLibreMap) => void;
  readonly interactive?: boolean;
}

export function createMap(options: CreateMapOptions): MapLibreMap {
  const mapOptions: MapOptions = {
    container: options.container,
    style: basemapStyleUrl(),
    center: options.center ?? NYC_CENTER,
    zoom: options.zoom ?? NYC_ZOOM,
    minZoom: NYC_MIN_ZOOM,
    maxZoom: NYC_MAX_ZOOM,
    pitch: 0,
    bearing: 0,
    attributionControl: { ...ATTRIBUTION_CONTROL_OPTIONS },
    // No `trackResize: false` — the map fills a mobile viewport that changes with the URL
    // bar. No geolocation control is added; the app asks for a position explicitly.
    interactive: options.interactive ?? true,
    fadeDuration: 0,
  };

  const map = new maplibregl.Map(mapOptions);

  if (options.onError !== undefined) {
    map.on('error', (event) => {
      options.onError?.(event.error instanceof Error ? event.error : new Error(String(event.error)));
    });
  }

  if (options.onStyleLoad !== undefined) {
    map.on('style.load', () => options.onStyleLoad?.(map));
  }

  return map;
}
