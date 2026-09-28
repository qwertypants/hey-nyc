/**
 * INTEGRATION NOTES (src/map/controller.ts)
 *
 * The imperative map handle. Everything that touches MapLibre lives here or in
 * `createMap.ts` / `style.ts`; nothing in `src/lib` or `src/data` imports MapLibre.
 *
 * ONE MapLibre instance per container, created once, never held in React state. React
 * holds this handle in a ref and re-renders from `subscribe`/`getState`, which is the
 * `useSyncExternalStore` shape — a torn-down or re-created map cannot trigger a render
 * loop, and no camera value is ever a source of React churn.
 *
 *   const controller = useMemo(
 *     () => createMapController({ container, initialView, initialFilters }),
 *     [container],
 *   );
 *   useEffect(() => () => controller.destroy(), [controller]);
 *   useSyncExternalStore(controller.subscribe, controller.getState);
 *
 * Calling `createMapController` twice for the same container returns the SAME controller
 * rather than a second WebGL context, so React 19 StrictMode's double effect is safe.
 *
 * THE CONTROLLER KNOWS NOTHING ABOUT FEATURES.
 *
 * It creates the map, holds the camera, reports the visible extent, and holds the two
 * values the URL mirrors — `filters` and `selectedId`. It does NOT draw anything and it
 * never sees a dataset: the source and the layers belong to whichever `MapFeature` is
 * mounted (see `src/features/registry.ts`), and the shell swaps that mount onto THIS map
 * when the visitor switches feature. That is what makes a switch a layer swap rather than
 * a teardown, and it is why the factory takes a container and a camera rather than a
 * dataset.
 *
 * `filters` and `selectedId` are therefore MIRRORS of state the feature owns: the shell
 * reads them to write the URL and to render, and pushes changes back down through
 * `FeatureView.state`. They live here rather than in React state because they arrive with
 * the map's own transitions (a click, a `moveend`), and a second copy in React is a copy
 * that can disagree with the first.
 *
 * Public surface:
 *   type MapStatus, type MapControllerState, type MapController, type CreateMapControllerOptions
 *   FOCUS_ZOOM
 *   createMapController(options): MapController
 *   getMapController(container): MapController | undefined
 */

import type { Map as MapLibreMap } from 'maplibre-gl';
import type { MapBounds } from '../lib/bounds';
import type { Filters } from '../lib/filters';
import { clampView, sameView, DEFAULT_VIEW } from '../lib/urlState';
import type { MapView } from '../lib/urlState';
import { fitViewFor } from '../lib/viewport';
import { createMap } from './createMap';
import { readBounds } from './extent';
import { DEFAULT_CAMERA_DURATION_MS, motionFor } from './motion';
import { LABEL_STYLE } from './style';
import type { LatLngLike } from '../features/registry';

export type MapStatus = 'loading' | 'ready' | 'error';

export interface MapControllerState {
  readonly status: MapStatus;
  /** Current camera, rounded for URL round-tripping. */
  readonly view: MapView;
  /** Mirror of the active feature's filters, so the URL can be written from one place. */
  readonly filters: Filters;
  /** Mirror of the active feature's selection. */
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
   * is an intent MapLibre already has by default; the field stays because `MapController` is
   * the boundary `src/App.tsx` calls through.
   */
  readonly essential?: boolean;
}

export interface MapController {
  /**
   * Resolves once the style is loaded, which is the first moment a feature may draw.
   * Rejects on a style error.
   */
  whenReady(): Promise<MapController>;
  /**
   * The MapLibre instance — the one place the UI layer gets at the engine. `null` before
   * creation, and the SAME instance for the life of the container: the shell hands it to
   * every feature it mounts, so switching feature is a layer swap on one map rather than
   * a second WebGL context.
   */
  getMap(): MapLibreMap | null;
  /** Stable snapshot for `useSyncExternalStore`; do not mutate. */
  getState(): MapControllerState;
  subscribe(listener: () => void): () => void;

  /** Records the active feature's filters. The feature applies them to its own layers. */
  setFilters(filters: Filters): void;
  /** Records the active feature's selection. The feature draws the highlight. */
  setSelectedId(id: string | null): void;
  /**
   * Selects AND flies. What tapping a list row or a search result does.
   *
   * The position is a parameter rather than a lookup because the controller has no
   * dataset: only the active feature can turn an id into a place, so the shell resolves it
   * (`FeatureView.positionOf`) and hands it over. `null` means the active feature has no
   * such item, and nothing happens — which is also how a selection left over from the
   * other feature is refused rather than flown to.
   */
  focusOn(id: string, position: LatLngLike | null): boolean;

  flyTo(view: Partial<MapView>, options?: FlyOptions): void;
  /** Fits the visible extent, with padding for the sheet UI Stream C draws over the map. */
  fitTo(bounds: MapBounds, options?: FlyOptions & { readonly padding?: number }): void;
  /**
   * Frames everything the active feature matches, to the extent the feature computed. The
   * same reason `focusOn` takes a position; `null` (nothing to frame) is a no-op rather
   * than a camera move to nowhere.
   */
  fitToResults(
    bounds: MapBounds | null,
    options?: FlyOptions & { readonly padding?: number },
  ): void;
  getBounds(): MapBounds | null;
  /** Call after the container resizes (sheet open/close, orientation change). */
  resize(): void;
  destroy(): void;
}

export interface CreateMapControllerOptions {
  readonly container: HTMLElement;
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

export function createMapController(options: CreateMapControllerOptions): MapController {
  const existing = controllers.get(options.container);
  if (existing !== undefined) return existing;

  const { container } = options;
  // `parseUrlState` returns exactly DEFAULT_VIEW when a link carries no usable view
  // parameters, so "equals DEFAULT_VIEW" is a faithful proxy for "the link did not ask for
  // a view". In that case frame the city for the viewport we actually have: a fixed
  // constant frames a 390px phone with New Jersey and letterboxes a 1440px desktop.
  // A link that does specify a view is honoured verbatim.
  const requestedView = clampView(options.initialView);
  const initialView = sameView(requestedView, DEFAULT_VIEW)
    ? fitViewFor(undefined, container.clientWidth, container.clientHeight)
    : requestedView;
  const initialFilters = options.initialFilters ?? { type: 'all', borough: 'all' };
  const initialSelectedId = options.initialSelectedId ?? null;

  const listeners = new Set<() => void>();
  let map: MapLibreMap | null = null;
  let detachBounds: (() => void) | null = null;
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
    publish({ selectedId: id });
  }

  function setFilters(filters: Filters): void {
    if (destroyed) return;
    publish({ filters });
  }

  /**
   * Style load is the ONLY moment at which a feature may draw — `addLayer` before a style
   * exists throws in MapLibre. So this is where the controller declares itself ready, and
   * the shell's mount effect, keyed on `state.status`, is what puts a feature on the map.
   *
   * Only the EXTENT is watched here. Clicks, hover and cluster expansion belong to
   * whichever feature is drawing and are attached and detached with it; a click handler
   * owned by the controller would outlive its layers, and there is no way for the shell to
   * unbind it on a switch.
   */
  function handleStyleLoad(readyMap: MapLibreMap): void {
    if (destroyed || detachBounds !== null) return;

    const reportBounds = (): void => {
      if (destroyed) return;
      publish({ bounds: readBounds(readyMap), view: currentView(readyMap) });
    };
    const subscriptions = [
      readyMap.on('moveend', reportBounds),
      readyMap.on('resize', reportBounds),
    ];
    detachBounds = (): void => {
      for (const subscription of subscriptions) subscription.unsubscribe();
    };

    publish({
      status: 'ready',
      bounds: readBounds(readyMap),
      view: currentView(readyMap),
      error: null,
    });
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

    focusOn(id: string, position: LatLngLike | null): boolean {
      if (destroyed || position === null) return false;
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

    fitToResults(
      bounds: MapBounds | null,
      fitOptions?: FlyOptions & { readonly padding?: number },
    ): void {
      if (destroyed || bounds === null) return;
      controller.fitTo(bounds, fitOptions);
    },

    getBounds: () => (map === null ? null : readBounds(map)),

    resize(): void {
      if (destroyed || map === null) return;
      map.resize();
    },

    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      detachBounds?.();
      detachBounds = null;
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
