/**
 * A `maplibre-gl` `Map` double, for the one thing jsdom cannot provide: a WebGL context.
 *
 * `tests/helpers/fakeController.ts` is a `MapController` double, which is the right seam for a
 * component test but the wrong one here: the thing under test is the set of OPTIONS the
 * controller hands MapLibre, and that only exists one layer down. So this is faithful all the
 * way down to `map.easeTo` / `map.fitBounds`, and records every call verbatim.
 *
 * Recording verbatim is the whole point. An assertion on `easeTo`'s arguments is the only
 * honest way to test "this camera move does not animate", because a reduced-motion move still
 * CALLS `easeTo` — MapLibre decides what to do with the duration and the `essential` flag. A
 * double that elided the call would make the test pass for the wrong reason.
 *
 * Faithful means: `addSource`/`getSource` round-trip so `expandCluster` finds the cluster
 * source, `on` really registers so `style.load` and `click` can be fired, and `getBounds` /
 * `getCenter` / `getZoom` answer so `readBounds` and the controller's view publish work.
 * Everything the camera tests do not touch is absent on purpose.
 *
 * Public surface:
 *   FakeMap, FakeMapOptions, FitBoundsCall
 *   createFakeMap(): FakeMap
 *   clusterFeature(clusterId, coordinates): unknown
 */

import type {
  AddLayerObject,
  EaseToOptions,
  FitBoundsOptions,
  GeoJSONSourceSpecification,
  Map as MapLibreMap,
} from 'maplibre-gl';
import { MIDTOWN_BOUNDS } from './fixtures';

export interface FitBoundsCall {
  readonly bounds: unknown;
  readonly options: FitBoundsOptions | undefined;
}

export interface FakeMapOptions {
  /** What `getClusterExpansionZoom` resolves with. A cluster click zooms to this. */
  readonly clusterExpansionZoom?: number;
  readonly center?: { readonly lng: number; readonly lat: number };
  readonly zoom?: number;
}

export interface FakeMap {
  /** The double, shaped as what `createMap` has to return. */
  readonly map: MapLibreMap;
  /** Every `easeTo` option object, in order, unmodified. */
  readonly easeToCalls: EaseToOptions[];
  /** Every `fitBounds` argument pair, in order, unmodified. */
  readonly fitBoundsCalls: FitBoundsCall[];
  /**
   * Register a map handler. The signature is deliberately narrower than MapLibre's overloaded
   * `on`, so a test wiring a callback does not have to satisfy the overloads.
   */
  on(type: string, handler: (event: never) => void): void;
  /** Fires `style.load`, which is what makes the controller add its source and layers. */
  loadStyle(): void;
  /** Fires a map event, e.g. `'click'` with a synthetic `MapMouseEvent`. */
  fire(type: string, event?: unknown): void;
  /** What the next `queryRenderedFeatures` returns. */
  setRenderedFeatures(features: readonly unknown[]): void;
  /** The ids of the layers the controller added. */
  readonly layerIds: () => string[];
  /**
   * The ids of the sources currently registered. `removeLayer` and `removeSource` keep this
   * honest, so `tests/feature-switching.test.tsx` can assert that a feature really took
   * everything down rather than that a counter happened to go back to where it started.
   */
  readonly sourceIds: () => string[];
  /**
   * How many handlers are registered right now, across every event type. A feature that
   * attaches a click handler and forgets to detach it shows up here immediately — which is
   * the leak a repeated switch produces, and the thing this fake exists to make visible.
   */
  readonly listenerCount: () => number;
  /**
   * Every call `queryRenderedFeatures` received, in order, WITH ITS OPTIONS. Typed rather
   * than `unknown[]` because "the hit test was scoped to these layers" is a claim about the
   * second argument, and a test cannot check a claim about a value it cannot read.
   */
  readonly queries: () => ReadonlyArray<{ readonly point: unknown; readonly options: unknown }>;
  /** Every `setFilter(layerId, filter)` pair, in order. */
  readonly setFilterCalls: () => ReadonlyArray<{ readonly layerId: string; readonly filter: unknown }>;
}

interface Registration {
  readonly type: string;
  readonly layerId: string | undefined;
  readonly handler: (event: never) => void;
}

export function createFakeMap(options: FakeMapOptions = {}): FakeMap {
  const easeToCalls: EaseToOptions[] = [];
  const fitBoundsCalls: FitBoundsCall[] = [];
  const registrations: Registration[] = [];
  const sources = new Map<string, GeoJSONSourceSpecification>();
  const layers = new Map<string, AddLayerObject>();
  const filters: Array<{ readonly layerId: string; readonly filter: unknown }> = [];
  const queries: Array<{ readonly point: unknown; readonly options: unknown }> = [];
  const center = options.center ?? { lng: -73.9855, lat: 40.758 };
  const zoom = options.zoom ?? 12;
  const clusterExpansionZoom = options.clusterExpansionZoom ?? 14;
  let renderedFeatures: readonly unknown[] = [];

  function on(
    type: string,
    layerIdOrHandler: string | ((event: never) => void),
    maybeHandler?: (event: never) => void,
  ): { unsubscribe: () => void } {
    const registration: Registration = {
      type,
      layerId: typeof layerIdOrHandler === 'string' ? layerIdOrHandler : undefined,
      handler:
        (typeof layerIdOrHandler === 'string' ? maybeHandler : layerIdOrHandler) ??
        ((): void => undefined),
    };
    registrations.push(registration);
    return {
      unsubscribe: () => {
        const index = registrations.indexOf(registration);
        if (index >= 0) registrations.splice(index, 1);
      },
    };
  }

  function fire(type: string, event: unknown): void {
    for (const registration of [...registrations]) {
      // Layer-scoped registrations (`mouseenter` on a layer id) are not addressable by type.
      if (registration.type === type && registration.layerId === undefined) {
        registration.handler(event as never);
      }
    }
  }

  const map = {
    on,

    off(type: string, layerIdOrHandler: string | ((event: never) => void), maybeHandler?: (event: never) => void) {
      const handler =
        (typeof layerIdOrHandler === 'string' ? maybeHandler : layerIdOrHandler) ??
        ((): void => undefined);
      const layerId = typeof layerIdOrHandler === 'string' ? layerIdOrHandler : undefined;
      for (let i = registrations.length - 1; i >= 0; i -= 1) {
        const entry = registrations[i];
        if (entry !== undefined && entry.type === type && entry.layerId === layerId && entry.handler === handler) {
          registrations.splice(i, 1);
        }
      }
      return map;
    },

    easeTo(easeToOptions: EaseToOptions) {
      easeToCalls.push(easeToOptions);
      return map;
    },

    fitBounds(bounds: unknown, fitOptions?: FitBoundsOptions) {
      fitBoundsCalls.push({ bounds, options: fitOptions });
      return map;
    },

    jumpTo() {
      return map;
    },

    getCenter() {
      return { ...center };
    },

    getZoom() {
      return zoom;
    },

    getBounds() {
      return {
        getWest: () => MIDTOWN_BOUNDS.west,
        getSouth: () => MIDTOWN_BOUNDS.south,
        getEast: () => MIDTOWN_BOUNDS.east,
        getNorth: () => MIDTOWN_BOUNDS.north,
      };
    },

    getCanvas() {
      return { style: {} };
    },

    addSource(id: string, source: GeoJSONSourceSpecification) {
      sources.set(id, source);
      return map;
    },

    getSource(id: string) {
      if (!sources.has(id)) return undefined;
      return {
        id,
        // `expandCluster` feature-detects this method, so a source that lacks it is a real
        // state of the world and the fake answers `undefined` when the id is unknown.
        getClusterExpansionZoom: () => Promise.resolve(clusterExpansionZoom),
      };
    },

    getLayer(id: string) {
      return layers.get(id);
    },

    addLayer(layer: AddLayerObject) {
      layers.set(layer.id, layer);
      return map;
    },

    // MapLibre refuses to remove a layer that is not there, and so does this: a feature that
    // tears down twice must fail loudly here rather than silently succeeding.
    removeLayer(id: string) {
      if (!layers.delete(id)) {
        throw new Error(`removeLayer("${id}"): no such layer`);
      }
      return map;
    },

    removeSource(id: string) {
      if (!sources.delete(id)) {
        throw new Error(`removeSource("${id}"): no such source`);
      }
      return map;
    },

    setFilter(layerId: string, filter: unknown) {
      filters.push({ layerId, filter });
      return map;
    },

    queryRenderedFeatures(point?: unknown, options?: unknown) {
      queries.push({ point, options });
      return renderedFeatures;
    },

    resize() {
      return map;
    },

    remove() {
      return map;
    },
  };

  return {
    map: map as unknown as MapLibreMap,
    easeToCalls,
    fitBoundsCalls,
    on: (type, handler) => {
      on(type, handler);
    },
    loadStyle: () => {
      fire('style.load', undefined);
    },
    fire,
    setRenderedFeatures: (features) => {
      renderedFeatures = features;
    },
    layerIds: () => [...layers.keys()],
    sourceIds: () => [...sources.keys()],
    listenerCount: () => registrations.length,
    queries: () => queries,
    setFilterCalls: () => filters,
  };
}

/** The rendered-feature shape `expandCluster` reads: a cluster bubble, with its id. */
export function clusterFeature(clusterId: number, coordinates: [number, number]): unknown {
  return {
    type: 'Feature',
    id: 0,
    geometry: { type: 'Point', coordinates },
    properties: { cluster_id: clusterId, point_count: 12 },
  };
}
