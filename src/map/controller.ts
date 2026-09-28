/**
 * INTEGRATION NOTES (src/map/controller.ts)
 *
 * The imperative map handle Stream C uses. Everything that touches MapLibre lives here or
 * in `createMap.ts` / `layers.ts`; nothing in `src/lib` or `src/data` imports MapLibre.
 *
 * ONE MapLibre instance per container, created once, never held in React state. React
 * holds this handle in a ref and re-renders from `subscribe`/`getState`, which is the
 * `useSyncExternalStore` shape — a torn-down or re-created map cannot trigger a render
 * loop, and no camera value is ever a source of React churn.
 *
 *   const controller = useMemo(
 *     () => createMapController({ container, dataset, initialView, initialFilters }),
 *     [container, dataset],
 *   );
 *   useEffect(() => () => controller.destroy(), [controller]);
 *   useSyncExternalStore(controller.subscribe, controller.getState);
 *
 * Calling `createMapController` twice for the same container returns the SAME controller
 * rather than a second WebGL context, so React 19 StrictMode's double effect is safe.
 *
 * Public surface:
 *   type MapStatus, type MapControllerState, type MapController, type CreateMapControllerOptions
 *   FOCUS_ZOOM
 *   createMapController(options): MapController
 *   getMapController(container): MapController | undefined
 */

import type { Map as MapLibreMap } from 'maplibre-gl';
import type { LoadedDataset } from '../data/load';
import type { MapBounds } from '../lib/bounds';
import type { Filters } from '../lib/filters';
import { applyFilters } from '../lib/filters';
import { clampView, sameView, DEFAULT_VIEW } from '../lib/urlState';
import type { MapView } from '../lib/urlState';
import { fitViewFor, NYC_DATA_BOUNDS } from '../lib/viewport';
import { createMap } from './createMap';
import { addLocationLayers, attachMapInteractions, readBounds } from './layers';
import type { LocationLayers } from './layers';
import { DEFAULT_CAMERA_DURATION_MS, motionFor } from './motion';
import { LABEL_STYLE } from './style';

export type MapStatus = 'loading' | 'ready' | 'error';

export interface MapControllerState {
  readonly status: MapStatus;
  /** Current camera, rounded for URL round-tripping. */
  readonly view: MapView;
  readonly filters: Filters;
  readonly selectedId: string | null;
  /** Visible extent, or `null` before the first render completes. */
  readonly bounds: MapBounds | null;
  readonly error: Error | null;
}

/** Zoom that dissolves every cluster and turns the label layer on. */
export const FOCUS_ZOOM = LABEL_STYLE.minZoom;

export interface FlyOptions {
  readonly duration?: number;
  /**
   * MapLibre's "override the user's reduced-motion setting" flag, not "this move matters".
   * `motionFor` overrules it while the preference is on, so the only thing it can still express
   * is an intent MapLibre already has by default; the field stays because `MapController` is the
   * boundary `src/App.tsx` calls through.
   */
  readonly essential?: boolean;
}

export interface MapController {
  /** Resolves once the style is loaded and the layers are on. Rejects on a style error. */
  whenReady(): Promise<MapController>;
  /** The MapLibre instance, for escape hatches. `null` before creation. */
  getMap(): MapLibreMap | null;
  /** Stable snapshot for `useSyncExternalStore`; do not mutate. */
  getState(): MapControllerState;
  subscribe(listener: () => void): () => void;

  /** Applies the filters to the map, to `state.filters`, and to `state.view` (unchanged). */
  setFilters(filters: Filters): void;
  /** Highlights without moving the camera — what a map click does. */
  setSelectedId(id: string | null): void;
  /** Selects AND flies to the location. What tapping a list row does. */
  focusOn(id: string): boolean;

  flyTo(view: Partial<MapView>, options?: FlyOptions): void;
  /** Fits the visible extent, with padding for the sheet UI Stream C draws over the map. */
  fitTo(bounds: MapBounds, options?: FlyOptions & { readonly padding?: number }): void;
  /** Frames every location matching the current filters. */
  fitToResults(options?: FlyOptions & { readonly padding?: number }): void;
  getBounds(): MapBounds | null;
  /** Call after the container resizes (sheet open/close, orientation change). */
  resize(): void;
  destroy(): void;
}

export interface CreateMapControllerOptions {
  readonly container: HTMLElement;
  readonly dataset: LoadedDataset;
  readonly initialView?: MapView;
  readonly initialFilters?: Filters;
  readonly initialSelectedId?: string | null;
  /** Surfaces MapLibre's own errors (style load failure, tile errors) to the app. */
  readonly onError?: (error: Error) => void;
}

const controllers = new WeakMap<HTMLElement, MapController>();

export function getMapController(container: HTMLElement): MapController | undefined {
  return controllers.get(container);
}

export function createMapController(
  options: CreateMapControllerOptions,
): MapController {
  const existing = controllers.get(options.container);
  if (existing !== undefined) return existing;

  const { container, dataset } = options;
  // `parseUrlState` returns exactly DEFAULT_VIEW when a link carries no usable view
  // parameters, so "equals DEFAULT_VIEW" is a faithful proxy for "the link did not ask for
  // a view". In that case frame the data for the viewport we actually have: a fixed
  // constant frames a 390px phone with New Jersey and letterboxes a 1440px desktop.
  // A link that does specify a view is honoured verbatim.
  const requestedView = clampView(options.initialView);
  const initialView = sameView(requestedView, DEFAULT_VIEW)
    ? fitViewFor(NYC_DATA_BOUNDS, container.clientWidth, container.clientHeight)
    : requestedView;
  const initialFilters = options.initialFilters ?? { type: 'all', borough: 'all' };
  const initialSelectedId = options.initialSelectedId ?? null;

  const listeners = new Set<() => void>();
  let map: MapLibreMap | null = null;
  let layers: LocationLayers | null = null;
  let detachInteractions: (() => void) | null = null;
  let destroyed = false;
  let readyResolve: (controller: MapController) => void = () => undefined;
  let readyReject: (error: Error) => void = () => undefined;
  const ready = new Promise<MapController>((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  // Nothing may await `whenReady()` in an error path; swallow the unhandled rejection.
  ready.catch(() => undefined);

  let state: MapControllerState = {
    status: 'loading',
    view: initialView,
    filters: initialFilters,
    selectedId: initialSelectedId,
    bounds: null,
    error: null,
  };

  function publish(next: Partial<MapControllerState>): void {
    if (destroyed) return;
    state = { ...state, ...next };
    for (const listener of listeners) listener();
  }

  function reportError(error: Error): void {
    publish({ status: 'error', error });
    options.onError?.(error);
    readyReject(error);
  }

  function currentView(active: MapLibreMap): MapView {
    const centre = active.getCenter();
    return clampView({ lng: centre.lng, lat: centre.lat, zoom: active.getZoom() });
  }

  function setSelectedId(id: string | null): void {
    if (destroyed) return;
    layers?.setSelectedId(id);
    publish({ selectedId: id });
  }

  function setFilters(filters: Filters): void {
    if (destroyed) return;
    layers?.setFilters(filters);
    publish({ filters });
  }

  function handleStyleLoad(readyMap: MapLibreMap): void {
    if (destroyed || layers !== null) return;
    layers = addLocationLayers(readyMap, dataset.collection, initialFilters);
    if (initialSelectedId !== null) layers.setSelectedId(initialSelectedId);
    detachInteractions = attachMapInteractions(readyMap, {
      onBoundsChange: (bounds) => {
        publish({ bounds, view: currentView(readyMap) });
      },
      onSelect: (id) => {
        setSelectedId(id);
      },
      onClearSelection: () => {
        setSelectedId(null);
      },
      onError: reportError,
      isActive: () => !destroyed,
    });

    publish({ status: 'ready', bounds: readBounds(readyMap), view: currentView(readyMap), error: null });
    readyResolve(controller);
  }

  const controller: MapController = {
    whenReady: () => ready,

    getMap: () => map,

    getState: () => state,

    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    setFilters,

    setSelectedId,

    focusOn(id: string): boolean {
      if (destroyed) return false;
      const position = dataset.coords.get(id);
      if (position === undefined) return false;
      setSelectedId(id);
      // Clamped to the map's own maxZoom so a link or a very wide sheet cannot break easeTo.
      const zoom = Math.min(Math.max(state.view.zoom, FOCUS_ZOOM), 16);
      controller.flyTo({ lng: position.lng, lat: position.lat, zoom });
      return true;
    },

    flyTo(view: Partial<MapView>, flyOptions?: FlyOptions): void {
      if (destroyed || map === null) return;
      const target = clampView({ ...state.view, ...view });
      map.easeTo({
        center: [target.lng, target.lat],
        zoom: target.zoom,
        ...motionFor({
          duration: flyOptions?.duration ?? DEFAULT_CAMERA_DURATION_MS,
          essential: flyOptions?.essential ?? false,
        }),
      });
      publish({ view: target });
    },

    fitTo(bounds: MapBounds, fitOptions?: FlyOptions & { readonly padding?: number }): void {
      if (destroyed || map === null) return;
      if (!(bounds.north > bounds.south) || !(bounds.east > bounds.west)) return;
      map.fitBounds(
        [
          [bounds.west, bounds.south],
          [bounds.east, bounds.north],
        ],
        {
          padding: fitOptions?.padding ?? 48,
          maxZoom: 16,
          // `fitBounds` forwards to `flyTo` (or `easeTo`, when `linear` is set), so the same
          // preference governs it as governs `flyTo` — stated here rather than inherited by
          // accident, because an option left out of this call is one MapLibre defaults away.
          ...motionFor({
            duration: fitOptions?.duration ?? DEFAULT_CAMERA_DURATION_MS,
            essential: fitOptions?.essential ?? false,
          }),
        },
      );
    },

    fitToResults(fitOptions?: FlyOptions & { readonly padding?: number }): void {
      if (destroyed) return;
      const matches = applyFilters(dataset.locations, state.filters);
      if (matches.length === 0) return;

      let west = Number.POSITIVE_INFINITY;
      let south = Number.POSITIVE_INFINITY;
      let east = Number.NEGATIVE_INFINITY;
      let north = Number.NEGATIVE_INFINITY;
      for (const location of matches) {
        const position = dataset.coords.get(location.id);
        if (position === undefined) continue;
        west = Math.min(west, position.lng);
        south = Math.min(south, position.lat);
        east = Math.max(east, position.lng);
        north = Math.max(north, position.lat);
      }
      if (!(north > south) || !(east > west)) return;
      controller.fitTo({ west, south, east, north }, fitOptions);
    },

    getBounds: () => (map === null ? null : readBounds(map)),

    resize(): void {
      if (destroyed || map === null) return;
      map.resize();
    },

    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      detachInteractions?.();
      detachInteractions = null;
      layers = null;
      listeners.clear();
      controllers.delete(container);
      const active = map;
      map = null;
      active?.remove();
    },
  };

  controllers.set(container, controller);

  // Created LAST, so the `style.load` handler can never observe a half-initialised
  // closure. `handleStyleLoad` references `controller`, which is now assigned.
  map = createMap({
    container,
    center: [initialView.lng, initialView.lat],
    zoom: initialView.zoom,
    onError: reportError,
    onStyleLoad: handleStyleLoad,
  });

  map.on('move', () => {
    if (map === null) return;
    publish({ view: currentView(map) });
  });

  return controller;
}
