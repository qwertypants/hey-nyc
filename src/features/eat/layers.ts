/**
 * INTEGRATION NOTES (src/features/eat/layers.ts)
 *
 * The GeoJSON source, every layer, the filter composition, and map interaction. This used
 * to be `src/map/layers.ts`, where the map CONTROLLER owned it; it belongs to the feature
 * because a feature owns what is drawn on the map, and the shell swaps it on and off a
 * single MapLibre instance when the visitor switches feature.
 *
 * No DOM markers anywhere: 2 000 locations are drawn as GPU layers, so panning is a repaint,
 * not 2 000 element updates.
 *
 * Public surface:
 *   SOURCE_ID, LAYER_IDS
 *   buildFilterExpression(filters): unknown
 *   type EatLayers
 *   addEatLayers(map, collection, filters): EatLayers
 *   removeEatLayers(map): void
 *   attachEatInteractions(map, handlers): () => void
 *
 * IDS, verbatim:
 *   source    eoy-locations
 *   clusters  eoy-clusters
 *   counts    eoy-cluster-count
 *   halo      eoy-unclustered-halo
 *   points    eoy-unclustered-point
 *   labels    eoy-point-label
 *   selection eoy-selected-point
 *
 * Filtering goes through `setFilter` only. Re-adding the source per filter change would
 * re-tile the whole dataset on every tap of a filter button; `setFilter` re-runs
 * supercluster in the worker, which is what it is for.
 *
 * THE UNMOUNT IS THE POINT OF THIS FILE EXISTING HERE. `removeEatLayers` is not a
 * convenience: `MapFeature.unmount` is what the shell calls on a switch and on teardown,
 * and `tests/feature-switching.test.tsx` switches repeatedly and asserts the layer count
 * and the listener count do not grow. Every id above is removed in reverse draw order, the
 * source goes last, and the interaction detach is called.
 */

import type { LocationCollection } from '../../types/location';
import type { Filters } from '../../lib/filters';
import type { MapLibreLike, MapRenderedFeature } from '../registry';
import { DEFAULT_CAMERA_DURATION_MS, motionFor } from '../../map/motion';
import { CLUSTER_STYLE, DINING_TYPE_STYLE_LIST, LABEL_STYLE, SELECTED_STYLE } from '../../map/style';
import type { TypeStyle } from '../../map/style';
import type { CircleLayerSpec, LayerSpec, SymbolLayerSpec } from './eatMap';

export const SOURCE_ID = 'eoy-locations';

export const LAYER_IDS = {
  clusters: 'eoy-clusters',
  clusterCount: 'eoy-cluster-count',
  halo: 'eoy-unclustered-halo',
  points: 'eoy-unclustered-point',
  labels: 'eoy-point-label',
  selection: 'eoy-selected-point',
} as const;

/** Every layer id, bottom to top. The one list `removeEatLayers` walks in reverse. */
const LAYER_ORDER: readonly string[] = [
  LAYER_IDS.clusters,
  LAYER_IDS.clusterCount,
  LAYER_IDS.halo,
  LAYER_IDS.points,
  LAYER_IDS.labels,
  LAYER_IDS.selection,
];

/** Clusters dissolve above this zoom, so the label layer never fights a bubble. */
const CLUSTER_MAX_ZOOM = 14;
const CLUSTER_RADIUS = 50;

type EqualsProperty = ['==', ['get', string], string];

/** Matches nothing: a contract location id is never an empty string. */
const NOTHING_SELECTED: EqualsProperty = ['==', ['get', 'id'], ''];

/**
 * The dining-type and borough filter as one MapLibre filter expression:
 *
 *   no filters  true
 *   one filter  ['==', ['get', 'type'], 'sidewalk']
 *   both        ['all', ['==', ['get', 'type'], 'both'], ['==', ['get', 'borough'], 'Queens']]
 *
 * Built from `Filters`, so the URL, the list and the map share one definition.
 */
export function buildFilterExpression(filters: Filters): unknown {
  const clauses: EqualsProperty[] = [];
  if (filters.type !== 'all') clauses.push(['==', ['get', 'type'], filters.type]);
  if (filters.borough !== 'all') clauses.push(['==', ['get', 'borough'], filters.borough]);
  const first = clauses[0];
  if (first === undefined) return true;
  return clauses.length === 1 ? first : ['all', ...clauses];
}

export function buildSelectionFilter(id: string | null): unknown {
  return id === null ? NOTHING_SELECTED : (['==', ['get', 'id'], id] as EqualsProperty);
}

/**
 * `['all', a, b]` for two filter expressions. `true` is MapLibre's identity for a filter, so
 * composing with it short-circuits rather than nesting — which keeps a one-dimension filter
 * a two-element expression instead of a three-element one, and keeps the expressions the
 * map reports in a `setFilter` call readable.
 */
function andFilter(a: unknown, b: unknown): unknown {
  if (a === true) return b;
  if (b === true) return a;
  return ['all', a, b];
}

/**
 * Builds `['match', ['get','type'], ...]` from the single vocabulary in `style.ts`, so no
 * colour, radius, stroke or word is written twice anywhere in the codebase.
 */
function matchByType(pick: (style: TypeStyle) => string | number): readonly unknown[] {
  const args: unknown[] = ['match', ['get', 'type']];
  let fallback: string | number = '';
  for (const style of DINING_TYPE_STYLE_LIST) {
    const value = pick(style);
    fallback = value;
    args.push(style.type, value);
  }
  args.push(fallback);
  return args;
}

/** Short type word for the high-zoom label: "Sidewalk", "Roadway", "Both". */
const TYPE_WORD: readonly unknown[] = matchByType((style) => style.shortLabel);

function clusterRadiusExpression(): readonly unknown[] {
  return [
    'step',
    ['get', 'point_count'],
    CLUSTER_STYLE.minRadius,
    10,
    CLUSTER_STYLE.minRadius + 4,
    50,
    CLUSTER_STYLE.minRadius + 8,
    200,
    CLUSTER_STYLE.maxRadius,
  ];
}

const CLUSTER_LAYER: Omit<CircleLayerSpec, 'filter'> = {
  id: LAYER_IDS.clusters,
  type: 'circle',
  source: SOURCE_ID,
  paint: {
    'circle-color': CLUSTER_STYLE.color,
    'circle-opacity': CLUSTER_STYLE.opacity,
    'circle-stroke-color': CLUSTER_STYLE.strokeColor,
    'circle-stroke-width': CLUSTER_STYLE.strokeWidth,
    'circle-radius': clusterRadiusExpression(),
  },
};

const CLUSTER_COUNT_LAYER: Omit<SymbolLayerSpec, 'filter'> = {
  id: LAYER_IDS.clusterCount,
  type: 'symbol',
  source: SOURCE_ID,
  layout: {
    'text-field': ['get', 'point_count_abbreviated'],
    'text-size': 12,
    'text-font': ['Noto Sans Bold'],
    'text-allow-overlap': true,
    'text-ignore-placement': true,
  },
  paint: {
    'text-color': CLUSTER_STYLE.textColor,
  },
};

/**
 * The `both` annulus. A MapLibre circle layer cannot punch a hole, so a ring is a solid
 * disc in the ring colour drawn UNDER a smaller type-coloured disc. This is the third
 * shape channel: it is what stops type from being colour-only at low zoom.
 */
const HALO_LAYER: Omit<CircleLayerSpec, 'filter'> = {
  id: LAYER_IDS.halo,
  type: 'circle',
  source: SOURCE_ID,
  paint: {
    'circle-color': matchByType((style) => style.outlineColor),
    'circle-radius': matchByType((style) => style.radius + 4),
    'circle-opacity': 1,
  },
};

const POINT_LAYER: Omit<CircleLayerSpec, 'filter'> = {
  id: LAYER_IDS.points,
  type: 'circle',
  source: SOURCE_ID,
  paint: {
    'circle-color': matchByType((style) => style.color),
    'circle-radius': matchByType((style) => style.radius),
    'circle-stroke-color': matchByType((style) => style.outlineColor),
    'circle-stroke-width': matchByType((style) => style.strokeWidth),
  },
};

/**
 * Text labels from z15.5. A printed legend, a screen reader and a small phone screen all
 * get the type as WORDS here, which is the channel that survives greyscale.
 */
const LABEL_LAYER: Omit<SymbolLayerSpec, 'filter'> = {
  id: LAYER_IDS.labels,
  type: 'symbol',
  source: SOURCE_ID,
  minzoom: LABEL_STYLE.minZoom,
  layout: {
    'text-field': ['concat', TYPE_WORD, ' · ', ['get', 'name']],
    'text-font': [...LABEL_STYLE.fontStack],
    'text-size': LABEL_STYLE.textSize,
    'text-max-width': LABEL_STYLE.maxWidthEm,
    'text-line-height': 1,
    'text-allow-overlap': false,
    'text-anchor': 'top',
    'text-offset': [0, 0.7],
    'text-padding': 2,
  },
  paint: {
    'text-color': LABEL_STYLE.textColor,
    'text-halo-color': LABEL_STYLE.haloColor,
    'text-halo-width': LABEL_STYLE.haloWidth,
  },
};

const SELECTION_LAYER: Omit<CircleLayerSpec, 'filter'> = {
  id: LAYER_IDS.selection,
  type: 'circle',
  source: SOURCE_ID,
  paint: {
    // A white disc under a dark ring reads on the pale `positron` basemap AND on satellite
    // imagery, so swapping VITE_BASEMAP_STYLE_URL does not make selection invisible.
    'circle-color': SELECTED_STYLE.color,
    'circle-radius': [
      'interpolate',
      ['linear'],
      ['zoom'],
      10,
      SELECTED_STYLE.minRadiusPixels,
      16,
      SELECTED_STYLE.radius,
    ],
    'circle-stroke-color': SELECTED_STYLE.ringColor,
    'circle-stroke-width': SELECTED_STYLE.ringWidth,
  },
};

const HAS_POINT_COUNT = ['has', 'point_count'];
const IS_TYPE_BOTH: EqualsProperty = ['==', ['get', 'type'], 'both'];

interface LayerDefinition {
  readonly id: string;
  /** How the shared dining/borough filter composes with this layer's own clause. */
  readonly filter: (shared: unknown) => unknown;
  readonly build: (filter: unknown) => LayerSpec;
}

/** Bottom-to-top draw order: halo under point, selection over everything. */
const LAYER_DEFINITIONS: readonly LayerDefinition[] = [
  {
    id: LAYER_IDS.clusters,
    filter: (shared) => andFilter(HAS_POINT_COUNT, shared),
    build: (filter) => ({ ...CLUSTER_LAYER, filter }),
  },
  {
    id: LAYER_IDS.clusterCount,
    filter: (shared) => andFilter(HAS_POINT_COUNT, shared),
    build: (filter) => ({ ...CLUSTER_COUNT_LAYER, filter }),
  },
  {
    id: LAYER_IDS.halo,
    filter: (shared) => andFilter(IS_TYPE_BOTH, shared),
    build: (filter) => ({ ...HALO_LAYER, filter }),
  },
  {
    id: LAYER_IDS.points,
    filter: (shared) => shared,
    build: (filter) => ({ ...POINT_LAYER, filter }),
  },
  {
    id: LAYER_IDS.labels,
    filter: (shared) => shared,
    build: (filter) => ({ ...LABEL_LAYER, filter }),
  },
  {
    id: LAYER_IDS.selection,
    filter: () => buildSelectionFilter(null),
    build: (filter) => ({ ...SELECTION_LAYER, filter }),
  },
];

/**
 * Owns the live filter/selection state so `setFilters` and `setSelectedId` can recompose
 * both clauses on a layer without either clobbering the other.
 */
export interface EatLayers {
  setFilters(filters: Filters): void;
  setSelectedId(id: string | null): void;
  readonly filters: Filters;
  readonly selectedId: string | null;
}

/**
 * Adds the source and every layer. Must run after `style.load` — which is why the shell only
 * mounts a feature once the controller reports `ready`.
 *
 * Idempotent by construction: a source that is already there is left alone and a layer that
 * is already there is skipped, so calling it twice cannot produce two of anything.
 */
export function addEatLayers(
  map: MapLibreLike,
  collection: LocationCollection,
  filters: Filters,
): EatLayers {
  if (map.getSource(SOURCE_ID) === undefined) {
    map.addSource(SOURCE_ID, {
      type: 'geojson',
      data: collection,
      cluster: true,
      clusterMaxZoom: CLUSTER_MAX_ZOOM,
      clusterRadius: CLUSTER_RADIUS,
      // Ids come from the features themselves, so no `generateId` bookkeeping is needed.
      generateId: false,
    });
  }

  const shared = buildFilterExpression(filters);
  for (const definition of LAYER_DEFINITIONS) {
    if (map.getLayer(definition.id) !== undefined) continue;
    map.addLayer(definition.build(definition.filter(shared)));
  }

  let currentFilters = filters;
  let currentSelection: string | null = null;

  return {
    setFilters(next: Filters): void {
      currentFilters = next;
      const nextShared = buildFilterExpression(next);
      for (const definition of LAYER_DEFINITIONS) {
        if (map.getLayer(definition.id) === undefined) continue;
        // The selection layer keeps its own id clause, so it is recomposed rather than
        // replaced — a selected point hidden by the active filter must stay hidden.
        if (definition.id === LAYER_IDS.selection) {
          map.setFilter(definition.id, andFilter(nextShared, buildSelectionFilter(currentSelection)));
          continue;
        }
        map.setFilter(definition.id, definition.filter(nextShared));
      }
    },
    setSelectedId(id: string | null): void {
      currentSelection = id;
      if (map.getLayer(LAYER_IDS.selection) === undefined) return;
      map.setFilter(
        LAYER_IDS.selection,
        andFilter(buildFilterExpression(currentFilters), buildSelectionFilter(currentSelection)),
      );
    },
    get filters(): Filters {
      return currentFilters;
    },
    get selectedId(): string | null {
      return currentSelection;
    },
  };
}

/**
 * Takes down everything `addEatLayers` and `attachEatInteractions` put up, in reverse order,
 * and says nothing if it is already down. Reverse order because the selection layer is drawn
 * over the points layer and MapLibre is order-sensitive about what it may remove.
 */
export function removeEatLayers(map: MapLibreLike): void {
  for (const id of [...LAYER_ORDER].reverse()) {
    if (map.getLayer(id) === undefined) continue;
    map.removeLayer(id);
  }
  if (map.getSource(SOURCE_ID) !== undefined) map.removeSource(SOURCE_ID);
}

export interface EatInteractionHandlers {
  readonly onSelect: (id: string) => void;
  readonly onClearSelection: () => void;
  readonly onError?: (error: Error) => void;
  /** `false` after `detach()`, so a late `getClusterExpansionZoom` resolution is ignored. */
  readonly isActive?: () => boolean;
}

const CLICKABLE_LAYER_IDS: readonly string[] = [
  LAYER_IDS.clusters,
  LAYER_IDS.halo,
  LAYER_IDS.points,
];

function featureCoordinates(feature: MapRenderedFeature): [number, number] | null {
  const geometry = feature.geometry;
  if (geometry === undefined || geometry === null) return null;
  if (geometry.type !== 'Point') return null;
  const coordinates = geometry.coordinates ?? [];
  const lng = coordinates[0];
  const lat = coordinates[1];
  if (typeof lng !== 'number' || typeof lat !== 'number') return null;
  return [lng, lat];
}

function featureString(feature: MapRenderedFeature, key: string): string | null {
  const value = feature.properties?.[key];
  return typeof value === 'string' ? value : null;
}

/** A GeoJSON source that can answer a cluster's expansion zoom, or one that cannot. */
interface ClusterSource {
  getClusterExpansionZoom?: (clusterId: number) => Promise<number>;
}

async function expandCluster(
  map: MapLibreLike,
  feature: MapRenderedFeature,
  isActive: () => boolean,
  report: (error: Error) => void,
): Promise<void> {
  const clusterId = Number(feature.properties?.['cluster_id']);
  const coordinates = featureCoordinates(feature);
  if (!Number.isFinite(clusterId) || coordinates === null) return;

  // `getSource` is typed `unknown` by the registry, because a feature has no business
  // caring what kind of source it is. This one method is the exception, and it is
  // feature-detected rather than assumed: a source without it is a real state of the world.
  const source = map.getSource(SOURCE_ID) as ClusterSource | undefined;
  if (source === undefined || typeof source.getClusterExpansionZoom !== 'function') return;

  try {
    const zoom = await source.getClusterExpansionZoom(clusterId);
    // The promise resolves a frame or more later; the user may have panned, switched
    // feature, or the map may already be torn down. There is no public `isDestroyed`, so
    // the caller tells us — and a switched-away feature answers `false`, which is what
    // stops a late zoom landing on somebody else's map.
    if (!isActive() || map.getSource(SOURCE_ID) === undefined) return;
    map.easeTo({
      center: coordinates,
      zoom,
      ...motionFor({ duration: DEFAULT_CAMERA_DURATION_MS, essential: false }),
    });
  } catch (error) {
    report(error instanceof Error ? error : new Error(String(error)));
  }
}

/**
 * Wires clicks and hover. Returns a detach function, which `MapFeature.unmount` calls — so
 * that switching feature leaves no click handler bound to a map the new feature is now
 * using, and no hover handler setting the cursor for layers that are no longer there.
 */
export function attachEatInteractions(
  map: MapLibreLike,
  handlers: EatInteractionHandlers,
): () => void {
  const subscriptions: Array<{ unsubscribe: () => void }> = [];
  let detached = false;
  const isActive = (): boolean => !detached;
  const report = (error: Error): void => handlers.onError?.(error);

  const onMapClick = (event: unknown): void => {
    const point = (event as { readonly point?: unknown } | null)?.point;
    const rendered = map.queryRenderedFeatures(point, { layers: [...CLICKABLE_LAYER_IDS] });
    const feature = rendered[0];
    if (feature === undefined) {
      handlers.onClearSelection();
      return;
    }
    if (feature.properties?.['cluster_id'] !== undefined) {
      void expandCluster(map, feature, handlers.isActive ?? isActive, report);
      return;
    }
    const id = featureString(feature, 'id');
    if (id !== null) handlers.onSelect(id);
  };

  subscriptions.push(map.on('click', onMapClick));

  for (const layerId of CLICKABLE_LAYER_IDS) {
    subscriptions.push(
      map.on('mouseenter', layerId, () => {
        map.getCanvas().style.cursor = 'pointer';
      }),
    );
    subscriptions.push(
      map.on('mouseleave', layerId, () => {
        map.getCanvas().style.cursor = '';
      }),
    );
  }

  return () => {
    detached = true;
    for (const subscription of subscriptions) subscription.unsubscribe();
    subscriptions.length = 0;
  };
}
