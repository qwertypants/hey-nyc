/**
 * INTEGRATION NOTES (src/map/layers.ts)
 *
 * The GeoJSON source, every layer, the filter composition, and map interaction. No DOM
 * markers anywhere: 2 000 locations are drawn as GPU layers, so panning is a repaint, not
 * 2 000 element updates.
 *
 * Stream C does not import this file — `controller.ts` wraps it. Public surface:
 *   SOURCE_ID, LAYER_IDS
 *   type MapBoundsHandler, type MapInteractionHandlers, type LocationLayers
 *   buildFilterExpression(filters): FilterSpecification
 *   buildSelectionFilter(id: string | null): FilterSpecification
 *   addLocationLayers(map, collection, filters): LocationLayers
 *   readBounds(map): MapBounds | null
 *   attachMapInteractions(map, handlers): () => void
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
 */

import type {
  AddLayerObject,
  CircleLayerSpecification,
  ExpressionSpecification,
  FilterSpecification,
  GeoJSONSource,
  Map as MapLibreMap,
  MapGeoJSONFeature,
  MapMouseEvent,
  SymbolLayerSpecification,
} from 'maplibre-gl';
import type { LocationCollection } from '../types/location';
import type { MapBounds } from '../lib/bounds';
import type { Filters } from '../lib/filters';
import { CLUSTER_STYLE, DINING_TYPE_STYLE_LIST, LABEL_STYLE, SELECTED_STYLE } from './style';
import type { TypeStyle } from './style';

export const SOURCE_ID = 'eoy-locations';

export const LAYER_IDS = {
  clusters: 'eoy-clusters',
  clusterCount: 'eoy-cluster-count',
  halo: 'eoy-unclustered-halo',
  points: 'eoy-unclustered-point',
  labels: 'eoy-point-label',
  selection: 'eoy-selected-point',
} as const;

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
export function buildFilterExpression(filters: Filters): FilterSpecification {
  const clauses: EqualsProperty[] = [];
  if (filters.type !== 'all') clauses.push(['==', ['get', 'type'], filters.type]);
  if (filters.borough !== 'all') clauses.push(['==', ['get', 'borough'], filters.borough]);
  const first = clauses[0];
  if (first === undefined) return true;
  return clauses.length === 1 ? first : ['all', ...clauses];
}

export function buildSelectionFilter(id: string | null): FilterSpecification {
  return id === null ? NOTHING_SELECTED : (['==', ['get', 'id'], id] as EqualsProperty);
}

/**
 * `['all', a, b]` for two filter expressions. The style spec types the `all` operator
 * against `boolean | ExpressionSpecification` while `FilterSpecification` also admits the
 * legacy form; every expression this file builds is already expression-form (MapLibre's
 * `isExpressionFilter` treats `['==', ['get', k], v]` as an expression, verified against
 * @maplibre/maplibre-gl-style-spec 5.24), so the widening is safe.
 */
function andFilter(a: FilterSpecification, b: FilterSpecification): FilterSpecification {
  if (a === true) return b;
  if (b === true) return a;
  return ['all', a, b] as unknown as FilterSpecification;
}

/**
 * Builds `['match', ['get','type'], ...]` from the single vocabulary in `style.ts`, so no
 * colour, radius, stroke or word is written twice anywhere in the codebase.
 */
function matchByType(pick: (style: TypeStyle) => string | number): ExpressionSpecification {
  const args: unknown[] = ['match', ['get', 'type']];
  let fallback: string | number = '';
  for (const style of DINING_TYPE_STYLE_LIST) {
    const value = pick(style);
    fallback = value;
    args.push(style.type, value);
  }
  args.push(fallback);
  return args as unknown as ExpressionSpecification;
}

/** Short type word for the high-zoom label: "Sidewalk", "Roadway", "Both". */
const TYPE_WORD: ExpressionSpecification = matchByType((style) => style.shortLabel);

function clusterRadiusExpression(): ExpressionSpecification {
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
  ] as unknown as ExpressionSpecification;
}

const CLUSTER_LAYER: CircleLayerSpecification = {
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

const CLUSTER_COUNT_LAYER: SymbolLayerSpecification = {
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
const HALO_LAYER: CircleLayerSpecification = {
  id: LAYER_IDS.halo,
  type: 'circle',
  source: SOURCE_ID,
  paint: {
    'circle-color': matchByType((style) => style.outlineColor),
    'circle-radius': matchByType((style) => style.radius + 4),
    'circle-opacity': 1,
  },
};

const POINT_LAYER: CircleLayerSpecification = {
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
const LABEL_LAYER: SymbolLayerSpecification = {
  id: LAYER_IDS.labels,
  type: 'symbol',
  source: SOURCE_ID,
  minzoom: LABEL_STYLE.minZoom,
  layout: {
    'text-field': ['concat', TYPE_WORD, ' · ', ['get', 'name']] as unknown as ExpressionSpecification,
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

const SELECTION_LAYER: CircleLayerSpecification = {
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
    ] as unknown as ExpressionSpecification,
    'circle-stroke-color': SELECTED_STYLE.ringColor,
    'circle-stroke-width': SELECTED_STYLE.ringWidth,
  },
};

const HAS_POINT_COUNT: FilterSpecification = ['has', 'point_count'];
const IS_TYPE_BOTH: EqualsProperty = ['==', ['get', 'type'], 'both'];

/**
 * `addLayer` takes `AddLayerObject`, a union discriminated on `type`. Spreading a
 * `LayerSpecification` union loses that link, so each layer is spread while it is still
 * concretely a circle or a symbol.
 */
function circleLayer(
  spec: CircleLayerSpecification,
  filter: FilterSpecification,
): AddLayerObject {
  const layer: CircleLayerSpecification = { ...spec, filter };
  return layer;
}

function symbolLayer(
  spec: SymbolLayerSpecification,
  filter: FilterSpecification,
): AddLayerObject {
  const layer: SymbolLayerSpecification = { ...spec, filter };
  return layer;
}

interface LayerDefinition {
  readonly id: string;
  /** How the shared dining/borough filter composes with this layer's own clause. */
  readonly filter: (shared: FilterSpecification) => FilterSpecification;
  readonly build: (filter: FilterSpecification) => AddLayerObject;
}

/** Bottom-to-top draw order: halo under point, selection over everything. */
const LAYER_DEFINITIONS: readonly LayerDefinition[] = [
  {
    id: LAYER_IDS.clusters,
    filter: (shared) => andFilter(HAS_POINT_COUNT, shared),
    build: (filter) => circleLayer(CLUSTER_LAYER, filter),
  },
  {
    id: LAYER_IDS.clusterCount,
    filter: (shared) => andFilter(HAS_POINT_COUNT, shared),
    build: (filter) => symbolLayer(CLUSTER_COUNT_LAYER, filter),
  },
  {
    id: LAYER_IDS.halo,
    filter: (shared) => andFilter(IS_TYPE_BOTH, shared),
    build: (filter) => circleLayer(HALO_LAYER, filter),
  },
  {
    id: LAYER_IDS.points,
    filter: (shared) => shared,
    build: (filter) => circleLayer(POINT_LAYER, filter),
  },
  {
    id: LAYER_IDS.labels,
    filter: (shared) => shared,
    build: (filter) => symbolLayer(LABEL_LAYER, filter),
  },
  {
    id: LAYER_IDS.selection,
    filter: () => buildSelectionFilter(null),
    build: (filter) => circleLayer(SELECTION_LAYER, filter),
  },
];

/**
 * Owns the live filter/selection state so `setFilters` and `setSelectedId` can recompose
 * both clauses on a layer without either clobbering the other.
 */
export interface LocationLayers {
  setFilters(filters: Filters): void;
  setSelectedId(id: string | null): void;
  readonly filters: Filters;
  readonly selectedId: string | null;
}

/** Adds the source and every layer. Must run after `style.load`. */
export function addLocationLayers(
  map: MapLibreMap,
  collection: LocationCollection,
  filters: Filters,
): LocationLayers {
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
        andFilter(shared, buildSelectionFilter(currentSelection)),
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

export function readBounds(map: MapLibreMap): MapBounds {
  const bounds = map.getBounds();
  return {
    west: bounds.getWest(),
    south: bounds.getSouth(),
    east: bounds.getEast(),
    north: bounds.getNorth(),
  };
}

export interface MapInteractionHandlers {
  /** Fired on `moveend`, `resize`, and once when the layers first go on. */
  readonly onBoundsChange: (bounds: MapBounds) => void;
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

function featureCoordinates(feature: MapGeoJSONFeature): [number, number] | null {
  const geometry = feature.geometry;
  if (geometry.type !== 'Point') return null;
  const lng = geometry.coordinates[0];
  const lat = geometry.coordinates[1];
  if (typeof lng !== 'number' || typeof lat !== 'number') return null;
  return [lng, lat];
}

function featureString(feature: MapGeoJSONFeature, key: string): string | null {
  const value = feature.properties?.[key];
  return typeof value === 'string' ? value : null;
}

async function expandCluster(
  map: MapLibreMap,
  feature: MapGeoJSONFeature,
  isActive: () => boolean,
  report: (error: Error) => void,
): Promise<void> {
  const clusterId = Number(feature.properties?.['cluster_id']);
  const coordinates = featureCoordinates(feature);
  if (!Number.isFinite(clusterId) || coordinates === null) return;

  const source = map.getSource(SOURCE_ID) as GeoJSONSource | undefined;
  if (source === undefined || typeof source.getClusterExpansionZoom !== 'function') return;

  try {
    const zoom = await source.getClusterExpansionZoom(clusterId);
    // The promise resolves a frame or more later; the user may have panned, or the map
    // may already be torn down. MapLibre has no public `isDestroyed`, so the caller tells us.
    if (!isActive() || map.getSource(SOURCE_ID) === undefined) return;
    map.easeTo({ center: coordinates, zoom, duration: 480 });
  } catch (error) {
    report(error instanceof Error ? error : new Error(String(error)));
  }
}

/**
 * Wires clicks, hover and `moveend`. Returns a detach function; the controller calls it from
 * `destroy()` so nothing stays bound to a dead map.
 */
export function attachMapInteractions(
  map: MapLibreMap,
  handlers: MapInteractionHandlers,
): () => void {
  const subscriptions: Array<{ unsubscribe: () => void }> = [];
  let detached = false;
  const isActive = (): boolean => !detached;
  const report = (error: Error): void => handlers.onError?.(error);

  const reportBounds = (): void => {
    if (detached) return;
    handlers.onBoundsChange(readBounds(map));
  };

  const onMapClick = (event: MapMouseEvent): void => {
    const rendered = map.queryRenderedFeatures(event.point, { layers: [...CLICKABLE_LAYER_IDS] });
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
  subscriptions.push(map.on('moveend', reportBounds));
  subscriptions.push(map.on('resize', reportBounds));

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
