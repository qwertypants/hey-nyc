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

    setFilter() {
      return map;
    },

    queryRenderedFeatures() {
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
