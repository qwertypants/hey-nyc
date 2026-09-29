/**
 * A `MapLibreLike` double for the walk layers.
 *
 * `tests/helpers/fakeMap.ts` is faithful all the way down to `easeTo` and `getBounds`, which
 * is right for a camera test and wrong here: the thing under test is the SET of layers and
 * sources the feature adds and removes, and that needs `removeLayer` / `removeSource` to
 * round-trip exactly as MapLibre's do — a `removeLayer` for an id that is not there must be a
 * no-op, and a second `addLayer` of the same id must not stack.
 *
 * It also counts listeners, because `MapFeature.mount` may add some and `unmount` must take
 * them all away. The registry's `MapLibreLike` has `on` / `off` for exactly that, and an
 * unmount that leaves one behind is the bug `tests/feature-switching.test.tsx` will catch for
 * the whole app.
 *
 * Public surface:
 *   WalkMapDouble, createWalkMap, WalkMapOptions
 *   walkIndexFrom(loaded) — the index a `LoadedWalk` already is, re-typed for convenience
 */

import type { MapLibreLike, MapRenderedFeature } from '../../src/features/registry';
import type { WalkIndex } from '../../src/data/walk/validate';
import { indexWalk, validateHistoricalCollection, validateHistoricalPatterns, validateSensorCollection } from '../../src/data/walk/validate';
import {
  HISTORICAL_COLLECTION,
  PATTERNS_RAW,
  SENSOR_COLLECTION,
} from './walkFixtures';

export interface WalkMapDouble extends MapLibreLike {
  /** The layer ids currently on the map, in insertion order. */
  readonly layerIds: () => readonly string[];
  readonly sourceIds: () => readonly string[];
  /** Every layer object ever passed to `addLayer`, including re-adds. */
  readonly addedLayers: () => readonly { id: string; source?: unknown }[];
  /** The data each source was last given, so the display activity can be inspected. */
  readonly sourceData: (id: string) => unknown;
  readonly setDataCalls: () => number;
  /** Every `setFilter` call, as `[layerId, filter]`. */
  readonly filterCalls: () => ReadonlyArray<{ readonly layerId: string; readonly filter: unknown }>;
  readonly listenerCount: () => number;
  /** Fires a map event at the listeners registered for it, layer-scoped ones included. */
  readonly fire: (type: string, event?: unknown) => void;
  /** What the next `queryRenderedFeatures` answers with. */
  readonly setRenderedFeatures: (features: readonly MapRenderedFeature[]) => void;
  /** Every hit test, as `[point, options]`, in order. */
  readonly queries: () => ReadonlyArray<{ readonly point: unknown; readonly options: unknown }>;
}

export function createWalkMap(): WalkMapDouble {
  const sources = new Map<string, unknown>();
  const layers = new Map<string, unknown>();
  const added: { id: string; source?: unknown }[] = [];
  const data = new Map<string, unknown>();
  const filters: { layerId: string; filter: unknown }[] = [];
  const queries: { point: unknown; options: unknown }[] = [];
  const handlers = new Map<string, Set<(event: never) => void>>();
  let rendered: readonly MapRenderedFeature[] = [];
  const canvas = { style: { cursor: '' } };
  let setDataCount = 0;

  const map: WalkMapDouble = {
    addSource(id, source) {
      sources.set(id, source);
      const spec = source as { data?: unknown } | undefined;
      if (spec !== undefined && spec !== null && 'data' in spec) data.set(id, spec.data);
    },
    getSource(id) {
      if (!sources.has(id)) return undefined;
      return {
        id,
        setData: (next: unknown) => {
          setDataCount += 1;
          data.set(id, next);
        },
      };
    },
    removeSource(id) {
      if (!sources.has(id)) throw new Error(`removeSource called for an absent source: ${id}`);
      sources.delete(id);
      data.delete(id);
    },
    addLayer(layer) {
      const spec = layer as { id: string; source?: unknown };
      added.push({ id: spec.id, source: spec.source });
      layers.set(spec.id, spec);
    },
    removeLayer(id) {
      // MapLibre throws on an unknown id, and so does this double: a silent no-op here would
      // make `unmount` look idempotent when it is actually guessing.
      if (!layers.has(id)) throw new Error(`removeLayer called for an absent layer: ${id}`);
      layers.delete(id);
    },
    getLayer(id) {
      return layers.get(id);
    },
    setFilter(layerId, filter) {
      if (!layers.has(layerId)) throw new Error(`setFilter called for an absent layer: ${layerId}`);
      filters.push({ layerId, filter });
    },
    /*
     * `on` is FAITHFUL about its return value, which is the point of the double: MapLibre
     * hands back a `Subscription` and that subscription is the only way a layer-scoped
     * listener comes off again. A double that returned `void` would let a feature detach
     * through `off` and pass, which is the other legal way — so the double has to count
     * what it actually removed, and a leak through one route has to show up in the same
     * number as a leak through the other.
     */
    on(event, layerIdOrHandler, maybeHandler) {
      const set = handlers.get(event) ?? new Set<(event: never) => void>();
      const attached = typeof layerIdOrHandler === 'function' ? layerIdOrHandler : maybeHandler;
      if (attached !== undefined) set.add(attached);
      handlers.set(event, set);
      return {
        unsubscribe: () => {
          if (attached !== undefined) set.delete(attached);
        },
      };
    },
    off(event, layerIdOrHandler, maybeHandler) {
      const attached = typeof layerIdOrHandler === 'function' ? layerIdOrHandler : maybeHandler;
      if (attached !== undefined) handlers.get(event)?.delete(attached);
    },
    queryRenderedFeatures(point, options) {
      // Recorded with its options, because "scoped to this feature's own layers" is a claim
      // about the second argument and there is no other way to observe it.
      queries.push({ point, options });
      return rendered;
    },
    getCanvas() {
      return canvas;
    },
    // Walk never moves the camera — the registry deliberately does not let a feature aim
    // one — so this exists only because the seam declares it for the clustered point layer
    // that Eat Outside draws, and the double is a `MapLibreLike` rather than a bespoke shape.
    easeTo() {
      return undefined;
    },

    layerIds: () => [...layers.keys()],
    sourceIds: () => [...sources.keys()],
    addedLayers: () => [...added],
    sourceData: (id) => data.get(id),
    setDataCalls: () => setDataCount,
    filterCalls: () => [...filters],
    listenerCount: () => {
      let total = 0;
      for (const set of handlers.values()) total += set.size;
      return total;
    },
    fire: (type, event) => {
      for (const handler of [...(handlers.get(type) ?? [])]) handler(event as never);
    },
    setRenderedFeatures: (features) => {
      rendered = features;
    },
    queries: () => [...queries],
  };

  return map;
}

/** The fixture index, validated through the real validators so a fixture cannot drift. */
export function fixtureIndex(): WalkIndex {
  return indexWalk(
    validateHistoricalCollection(HISTORICAL_COLLECTION),
    validateSensorCollection(SENSOR_COLLECTION),
    validateHistoricalPatterns(PATTERNS_RAW),
    { latestObservation: null, sensors: [] },
  );
}
