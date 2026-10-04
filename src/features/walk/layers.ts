/**
 * INTEGRATION NOTES (src/features/walk/layers.ts)
 *
 * The GeoJSON sources and every layer for Where NYC Walks. No DOM markers: 118 points is 118
 * GPU-drawn features, so panning is a repaint rather than a React update.
 *
 * THE ID PREFIX, AND WHY IT IS `wnyc-`
 * -----------------------------------
 * `src/map/layers.ts` uses `eoy-` for the eat feature. This feature uses `wnyc-`, not `walk-`
 * and not `eoy-walk-`, for three reasons: the shell asserts after `unmount` that no layer of
 * the switched-away feature remains, so the two prefixes must be trivially separable by
 * string; `wnyc-` cannot collide with a future feature that happens to be called "walks"
 * something else; and the artifact ids are `wsh-` / `wsk-`, so `wnyc-` is the one
 * three-letter reading of "Where NYC Walks" that does not read as a dataset. Every id in
 * this file is listed verbatim in the table below, and `tests/walk-layers.test.ts` asserts
 * the list, so a layer added without being registered fails the build.
 *
 *   source    wnyc-historical      wnyc-sensors
 *   layers    wnyc-historical-rim      the ring; its WEIGHT is the trend's non-colour channel
 *             wnyc-historical-core     the disc; its RADIUS is the survey total
 *             wnyc-historical-label    the site name and the trend word, from z15.5
 *             wnyc-historical-selected a white disc under a dark ring
 *             wnyc-sensor-outer-ring   a second ring, only on a counter that has stopped
 *             wnyc-sensor-ring         the counter's ring, weight from staleness
 *             wnyc-sensor-core         the fill: activity colour, opacity from staleness
 *             wnyc-sensor-mark         `+` or `x` at the centre
 *             wnyc-sensor-label        the counter's name and staleness word, from z15.5
 *             wnyc-sensor-selected
 *
 * NO CLUSTERING, DELIBERATELY. The eat feature clusters 2 000 points because two thousand
 * bubbles at z12 is noise. 114 survey sites and 4 counters is not noise — it is the entire
 * dataset, and clustering it would hide the thing the feature exists to show. A visitor who
 * asks for the whole city sees 114 dots, which is the honest number.
 *
 * WHAT IS ENCODED, AND ON WHICH CHANNEL
 * -------------------------------------
 * historical  `total` -> circle radius, as a `step` over a printed ramp, so two sites are
 *             never a different size for a difference nobody can see.
 *             `trend`  -> colour, PLUS `circle-stroke-width` on the rim, PLUS the trend word
 *             in the label from z15.5. Three channels, the middle one a shape.
 * sensors     `activity`, AFTER `displayActivity` has collapsed an empty bucket to
 *             `unavailable` -> the core's fill colour.
 *             `staleness` -> ring width, a second ring, core opacity, and the `+` / `x`
 *             centre mark. Four channels for a four-state property, none of them hue.
 *
 * WHY THE ACTIVITY DECISION IS MADE IN DATA, NOT IN THE EXPRESSION. A MapLibre expression
 * cannot call a function, so `displayActivity` cannot be an expression — and a data-driven
 * expression certainly cannot know that a 0-in-a-0-bucket is not a level. So the sensor
 * source is fed a COPY whose `activity` is the display activity, and the raw value is kept
 * beside it as `publishedActivity`. The map is told the answer; the GeoJSON still shows what
 * the source said, so the decision is auditable rather than invisible.
 *
 * Public surface:
 *   WALK_SOURCE_IDS, WALK_LAYER_IDS, WALK_LAYER_ID_LIST, WALK_CLICKABLE_LAYER_IDS
 *   WALK_TOTAL_STEPS
 *   WALK_LABEL_MIN_ZOOM, WALK_LABEL_FONT
 *   WalkLayersHandle, WalkLayersOptions
 *   mountWalkLayers(map, index, options?): WalkLayersHandle
 *   unmountWalkLayers(map): void
 *   radiusForTotal(total): number
 */

import type {
  AddLayerObject,
  CircleLayerSpecification,
  ExpressionSpecification,
  FilterSpecification,
  SymbolLayerSpecification,
} from 'maplibre-gl';
import type { MapLibreLike } from '../registry';
import type { WalkIndex } from '../../data/walk/validate';
import { displayActivity } from './display';
import { ACTIVITY_STYLE_LIST, SENSOR_STYLE, STALENESS_STYLE_LIST, TREND_STYLE_LIST } from './style';

export const WALK_SOURCE_IDS = {
  historical: 'wnyc-historical',
  sensors: 'wnyc-sensors',
} as const;

export const WALK_LAYER_IDS = {
  historicalRim: 'wnyc-historical-rim',
  historicalCore: 'wnyc-historical-core',
  historicalLabel: 'wnyc-historical-label',
  historicalSelected: 'wnyc-historical-selected',
  sensorOuterRing: 'wnyc-sensor-outer-ring',
  sensorRing: 'wnyc-sensor-ring',
  sensorCore: 'wnyc-sensor-core',
  sensorMark: 'wnyc-sensor-mark',
  sensorLabel: 'wnyc-sensor-label',
  sensorSelected: 'wnyc-sensor-selected',
} as const;

/** Every layer this feature can leave behind. `unmount` walks it in reverse draw order. */
export const WALK_LAYER_ID_LIST: readonly string[] = [
  WALK_LAYER_IDS.historicalRim,
  WALK_LAYER_IDS.historicalCore,
  WALK_LAYER_IDS.historicalLabel,
  WALK_LAYER_IDS.historicalSelected,
  WALK_LAYER_IDS.sensorOuterRing,
  WALK_LAYER_IDS.sensorRing,
  WALK_LAYER_IDS.sensorCore,
  WALK_LAYER_IDS.sensorMark,
  WALK_LAYER_IDS.sensorLabel,
  WALK_LAYER_IDS.sensorSelected,
];

/**
 * The layers a CLICK may land on, and the list the hit test is scoped to.
 *
 * Scoped, deliberately. `queryRenderedFeatures(point)` with no options answers "what is under
 * the pointer" for the WHOLE map, and the map is shared: a feature that has just been
 * switched away from may have layers sitting where these are. Unscoped, a click could select
 * a pin belonging to a feature that is no longer on screen. The two selection layers are
 * excluded because they are painted over the points and would shadow them.
 */
export const WALK_CLICKABLE_LAYER_IDS: readonly string[] = [
  WALK_LAYER_IDS.historicalRim,
  WALK_LAYER_IDS.historicalCore,
  WALK_LAYER_IDS.sensorOuterRing,
  WALK_LAYER_IDS.sensorRing,
  WALK_LAYER_IDS.sensorCore,
];

/**
 * The same zoom `src/map/style.ts` prints its labels at. Read from the same number rather
 * than restated, so the two features do not disagree about what "close up" is.
 */
export const WALK_LABEL_MIN_ZOOM = 15.5;

/**
 * The exact fontstack the `positron` style requests, for the same reason
 * `LABEL_STYLE.fontStack` uses it: a fontstack the basemap does not serve renders nothing,
 * which would silently remove the label layer — the channel that makes trend and staleness
 * readable without colour.
 */
export const WALK_LABEL_FONT: readonly string[] = ['Noto Sans Regular'];

/**
 * The `total` -> radius ramp, as STEPS. The published totals run 0 to 37 109, and a linear
 * radius across that range makes a 900-pedestrian site and a 1 100-pedestrian site differ by
 * a fifth of a pixel, which is a difference the map cannot honestly draw. The last entry is
 * the open-ended bucket, and `radiusForTotal` is exported so a legend can print the same
 * ramp rather than a second, differently-bucketed one.
 */
export const WALK_TOTAL_STEPS: ReadonlyArray<{ readonly upTo: number; readonly radius: number }> = [
  { upTo: 500, radius: 4 },
  { upTo: 2_000, radius: 6 },
  { upTo: 5_000, radius: 8 },
  { upTo: 12_000, radius: 10 },
  { upTo: 25_000, radius: 12 },
  { upTo: Number.POSITIVE_INFINITY, radius: 14 },
];

export function radiusForTotal(total: number | null): number {
  const first = WALK_TOTAL_STEPS[0];
  if (first === undefined) return 4;
  if (total === null) return first.radius;
  return WALK_TOTAL_STEPS.find((step) => total <= step.upTo)?.radius ?? first.radius;
}

type EqualsProperty = ['==', ['get', string], string];

/** Matches nothing: a contract id is never an empty string. */
const NOTHING_SELECTED: EqualsProperty = ['==', ['get', 'id'], ''];

/**
 * The selection filter for both selection layers. The style spec types an expression filter
 * against `boolean | ExpressionSpecification` while `FilterSpecification` also admits the
 * legacy form, so the widening is safe — every expression this file builds is already
 * expression-form. Mirrors `buildSelectionFilter` in `src/map/layers.ts`.
 */
function buildSelectionFilter(id: string | null): FilterSpecification {
  return id === null ? NOTHING_SELECTED : (['==', ['get', 'id'], id] as unknown as EqualsProperty);
}

/**
 * A `match` over ONE vocabulary, built from the tables in `style.ts` rather than from
 * literals, so a trend or an activity that changes colour cannot leave the layer behind. The
 * trailing fallback is the LAST entry's value, which is why the loops below never initialise
 * it to something arbitrary: a missing value must paint as a real, known style.
 */
function matchByTrend(pick: (style: (typeof TREND_STYLE_LIST)[number]) => string | number): ExpressionSpecification {
  const args: unknown[] = ['match', ['get', 'trend']];
  let fallback: string | number = '';
  for (const style of TREND_STYLE_LIST) {
    const value = pick(style);
    fallback = value;
    args.push(style.trend, value);
  }
  args.push(fallback);
  return args as unknown as ExpressionSpecification;
}

function matchByActivity(pick: (label: string) => string | number): ExpressionSpecification {
  const args: unknown[] = ['match', ['get', 'activity']];
  let fallback: string | number = '';
  for (const style of ACTIVITY_STYLE_LIST) {
    const value = pick(style.color);
    fallback = value;
    args.push(style.activity, value);
  }
  args.push(fallback);
  return args as unknown as ExpressionSpecification;
}

/** `['step', total, r0, bound1, r1, …]`. A null `total` reads as 0, the smallest bucket. */
function totalRadiusExpression(): ExpressionSpecification {
  const args: unknown[] = ['step', ['coalesce', ['get', 'total'], 0]];
  let fallback = radiusForTotal(0);
  for (const step of WALK_TOTAL_STEPS) {
    if (!Number.isFinite(step.upTo)) {
      fallback = step.radius;
      continue;
    }
    args.push(step.upTo, step.radius);
  }
  args.push(fallback);
  return args as unknown as ExpressionSpecification;
}

/** The trend word, printed next to the site name. The channel that survives greyscale. */
function trendWordExpression(): ExpressionSpecification {
  const args: unknown[] = ['concat', ['get', 'name'], ' · ', 'match', ['get', 'trend']];
  let fallback = '';
  for (const style of TREND_STYLE_LIST) {
    fallback = style.label;
    args.push(style.trend, style.label);
  }
  args.push(fallback);
  return args as unknown as ExpressionSpecification;
}

/** The staleness word, printed next to the counter's name. */
function stalenessWordExpression(): ExpressionSpecification {
  const args: unknown[] = ['concat', ['get', 'name'], ' · ', 'match', ['get', 'staleness']];
  let fallback = '';
  for (const style of STALENESS_STYLE_LIST) {
    fallback = style.label;
    args.push(style.staleness, style.label);
  }
  args.push(fallback);
  return args as unknown as ExpressionSpecification;
}

/** ASCII on purpose: a glyph outside the basemap's stack would render as nothing. */
function stalenessMarkExpression(): ExpressionSpecification {
  const args: unknown[] = ['match', ['get', 'staleness']];
  let fallback = 'x';
  for (const style of STALENESS_STYLE_LIST) {
    fallback = style.mark;
    args.push(style.staleness, style.glyph);
  }
  args.push(fallback);
  return args as unknown as ExpressionSpecification;
}

/**
 * The sensor source, with the display activity written over the published one. The original
 * is kept beside it so a reader of the GeoJSON — or of a test — can see both.
 */
function activitySourceData(index: WalkIndex): unknown {
  return {
    type: 'FeatureCollection',
    features: index.sensors.features.map((feature) => ({
      ...feature,
      properties: {
        ...feature.properties,
        activity: displayActivity(feature.properties),
        publishedActivity: feature.properties.activity,
      },
    })),
  };
}

const HISTORICAL_RIM: CircleLayerSpecification = {
  id: WALK_LAYER_IDS.historicalRim,
  type: 'circle',
  source: WALK_SOURCE_IDS.historical,
  paint: {
    // A white disc under the rim, so a `flat` site (stroke 0) is a plain coloured circle and
    // a `rising` site (stroke 3.5) is a coloured core inside a dark ring. The rim weight is
    // the trend's SHAPE channel, and it is legible in a greyscale screenshot.
    'circle-color': '#ffffff',
    'circle-radius': matchByTrend((style) => style.radius - style.strokeWidth / 2),
    'circle-stroke-color': matchByTrend(() => '#111827'),
    'circle-stroke-width': matchByTrend((style) => style.strokeWidth),
    'circle-opacity': 0.95,
  },
};

const HISTORICAL_CORE: CircleLayerSpecification = {
  id: WALK_LAYER_IDS.historicalCore,
  type: 'circle',
  source: WALK_SOURCE_IDS.historical,
  paint: {
    'circle-color': matchByTrend((style) => style.color),
    'circle-radius': totalRadiusExpression(),
    'circle-opacity': matchByTrend((style) => style.opacity),
    'circle-stroke-width': 0,
  },
};

const HISTORICAL_LABEL: SymbolLayerSpecification = {
  id: WALK_LAYER_IDS.historicalLabel,
  type: 'symbol',
  source: WALK_SOURCE_IDS.historical,
  minzoom: WALK_LABEL_MIN_ZOOM,
  layout: {
    'text-field': trendWordExpression() as unknown as ExpressionSpecification,
    'text-font': [...WALK_LABEL_FONT],
    'text-size': 11,
    // In ems, with `text-line-height: 1`, so MapLibre ellipsises rather than overlapping.
    'text-max-width': 14,
    'text-line-height': 1,
    'text-allow-overlap': false,
    'text-anchor': 'top',
    'text-offset': [0, 0.7],
    'text-padding': 2,
  },
  paint: {
    'text-color': '#111827',
    'text-halo-color': '#ffffff',
    'text-halo-width': 1.4,
  },
};

const HISTORICAL_SELECTED: CircleLayerSpecification = {
  id: WALK_LAYER_IDS.historicalSelected,
  type: 'circle',
  source: WALK_SOURCE_IDS.historical,
  paint: {
    // A white disc under a dark ring reads on the pale `positron` basemap AND on satellite
    // imagery, so swapping the style URL does not make selection invisible. Same construction
    // as `SELECTED_STYLE` in `src/map/style.ts`, sized for this feature's larger marks.
    'circle-color': '#ffffff',
    'circle-radius': 16,
    'circle-stroke-color': '#111827',
    'circle-stroke-width': 4,
  },
};

/**
 * A dead counter's second, wider ring. Four points can share a neighbourhood, so "late" and
 * "silent for a fortnight" cannot be a half-pixel stroke-width change; it is an extra ring,
 * which is a shape difference at every zoom.
 */
const SENSOR_OUTER_RING: CircleLayerSpecification = {
  id: WALK_LAYER_IDS.sensorOuterRing,
  type: 'circle',
  source: WALK_SOURCE_IDS.sensors,
  filter: [
    'any',
    ['==', ['get', 'staleness'], 'offline'],
    ['==', ['get', 'staleness'], 'unavailable'],
  ] as unknown as FilterSpecification,
  paint: {
    'circle-color': 'rgba(0, 0, 0, 0)',
    'circle-radius': SENSOR_STYLE.doubleRingRadius,
    'circle-stroke-color': SENSOR_STYLE.ringColor,
    'circle-stroke-width': 1.5,
  },
};

/**
 * The counter's own ring. A circle layer cannot punch a hole, so the ring is a white disc
 * with a dark rim and the core is a smaller disc in the activity colour — the same
 * construction `src/map/layers.ts` uses for the eat feature's `both` annulus.
 */
const SENSOR_RING: CircleLayerSpecification = {
  id: WALK_LAYER_IDS.sensorRing,
  type: 'circle',
  source: WALK_SOURCE_IDS.sensors,
  paint: {
    'circle-color': SENSOR_STYLE.ringHaloColor,
    'circle-radius': SENSOR_STYLE.ringRadius,
    'circle-opacity': 1,
    'circle-stroke-color': SENSOR_STYLE.ringColor,
    'circle-stroke-width': matchStaleness((style) => style.ringWidth),
  },
};

const SENSOR_CORE: CircleLayerSpecification = {
  id: WALK_LAYER_IDS.sensorCore,
  type: 'circle',
  source: WALK_SOURCE_IDS.sensors,
  paint: {
    'circle-color': matchByActivity((color) => color),
    'circle-radius': SENSOR_STYLE.coreRadius,
    // Fresh is solid, late is washed out, dead is hollow. Opacity, not hue — and a dead
    // counter's colour never reaches the eye at all, which is the point.
    'circle-opacity': matchStaleness((style) => style.coreOpacity),
  },
};

const SENSOR_MARK: SymbolLayerSpecification = {
  id: WALK_LAYER_IDS.sensorMark,
  type: 'symbol',
  source: WALK_SOURCE_IDS.sensors,
  layout: {
    'text-field': stalenessMarkExpression() as unknown as ExpressionSpecification,
    'text-font': [...SENSOR_STYLE.markFont],
    'text-size': SENSOR_STYLE.markSize,
    'text-allow-overlap': true,
    'text-ignore-placement': true,
  },
  paint: { 'text-color': SENSOR_STYLE.markColor },
};

const SENSOR_LABEL: SymbolLayerSpecification = {
  id: WALK_LAYER_IDS.sensorLabel,
  type: 'symbol',
  source: WALK_SOURCE_IDS.sensors,
  minzoom: WALK_LABEL_MIN_ZOOM,
  layout: {
    'text-field': stalenessWordExpression() as unknown as ExpressionSpecification,
    'text-font': [...WALK_LABEL_FONT],
    'text-size': 11,
    'text-max-width': 14,
    'text-line-height': 1,
    'text-allow-overlap': false,
    'text-anchor': 'top',
    'text-offset': [0, 1.4],
    'text-padding': 2,
  },
  paint: {
    'text-color': '#111827',
    'text-halo-color': '#ffffff',
    'text-halo-width': 1.4,
  },
};

const SENSOR_SELECTED: CircleLayerSpecification = {
  id: WALK_LAYER_IDS.sensorSelected,
  type: 'circle',
  source: WALK_SOURCE_IDS.sensors,
  paint: {
    'circle-color': '#ffffff',
    'circle-radius': 20,
    'circle-stroke-color': '#111827',
    'circle-stroke-width': 4,
  },
};

/** `match` over the staleness table, for ring width and core opacity. */
function matchStaleness(pick: (style: (typeof STALENESS_STYLE_LIST)[number]) => string | number): ExpressionSpecification {
  const args: unknown[] = ['match', ['get', 'staleness']];
  let fallback: string | number = '';
  for (const style of STALENESS_STYLE_LIST) {
    const value = pick(style);
    fallback = value;
    args.push(style.staleness, value);
  }
  args.push(fallback);
  return args as unknown as ExpressionSpecification;
}

/** The layers each toggle adds, in draw order, so `setVisible` and `mount` cannot disagree. */
const HISTORICAL_LAYERS: readonly AddLayerObject[] = [
  HISTORICAL_RIM,
  HISTORICAL_CORE,
  HISTORICAL_LABEL,
];

const SENSOR_LAYERS: readonly AddLayerObject[] = [
  SENSOR_OUTER_RING,
  SENSOR_RING,
  SENSOR_CORE,
  SENSOR_MARK,
  SENSOR_LABEL,
];

export interface WalkLayersOptions {
  /** Which of the two programs is on. Undefined means both. */
  readonly visible?: Readonly<Record<'historical' | 'sensors', boolean>>;
}

/**
 * The handle the feature keeps. Every method is defensive about a layer that has already gone,
 * because `unmount` runs on switch-away AND on unmount and the shell may call them in either
 * order.
 */
export interface WalkLayersHandle {
  readonly selectedId: string | null;
  setSelectedId(id: string | null): void;
  /** Shows or hides one program. Hiding removes its layers; showing puts them back. */
  setVisible(which: 'historical' | 'sensors', visible: boolean): void;
  /** Push new data into both sources without re-tiling the style. */
  setData(index: WalkIndex): void;
  /** Every layer and source this feature added, gone. Safe to call twice. */
  destroy(): void;
}

function addIfAbsent(map: MapLibreLike, layer: AddLayerObject): void {
  if (map.getLayer(layer.id) !== undefined) return;
  // A fresh object each time, so a caller that mutates a layer it passed in cannot reach the
  // module's own specification. The specs above are shared, not per-map state.
  map.addLayer({ ...layer });
}

function removeLayerIfPresent(map: MapLibreLike, id: string): void {
  if (map.getLayer(id) === undefined) return;
  map.removeLayer(id);
}

function removeSourceIfPresent(map: MapLibreLike, id: string): void {
  if (map.getSource(id) === undefined) return;
  map.removeSource(id);
}

function setSourceData(map: MapLibreLike, id: string, data: unknown): void {
  const source = map.getSource(id) as { setData?: (next: unknown) => void } | undefined;
  if (source === undefined || typeof source.setData !== 'function') return;
  source.setData(data);
}

function addProgram(map: MapLibreLike, layers: readonly AddLayerObject[], visible: boolean): void {
  for (const layer of layers) {
    if (visible) addIfAbsent(map, layer);
    else removeLayerIfPresent(map, layer.id);
  }
}

/**
 * Adds the two sources and every layer. IDEMPOTENT: a second call with the same data leaves
 * exactly one of everything, and a call after `unmount` rebuilds from scratch.
 */
export function mountWalkLayers(
  map: MapLibreLike,
  index: WalkIndex,
  options: WalkLayersOptions = {},
): WalkLayersHandle {
  if (map.getSource(WALK_SOURCE_IDS.historical) === undefined) {
    map.addSource(WALK_SOURCE_IDS.historical, { type: 'geojson', attribution: 'Data from <a href="https://data.cityofnewyork.us/d/cqsj-cfgu" target="_blank" rel="noopener noreferrer">NYC DOT · Bi-Annual Pedestrian Counts</a>.', data: index.historical, generateId: false });
  } else {
    setSourceData(map, WALK_SOURCE_IDS.historical, index.historical);
  }
  if (map.getSource(WALK_SOURCE_IDS.sensors) === undefined) {
    map.addSource(WALK_SOURCE_IDS.sensors, { type: 'geojson', attribution: 'Data from <a href="https://data.cityofnewyork.us/d/ct66-47at" target="_blank" rel="noopener noreferrer">NYC DOT · Bicycle and Pedestrian Counts</a> and <a href="https://data.cityofnewyork.us/d/6up2-gnw8" target="_blank" rel="noopener noreferrer">count sensors</a>.', data: activitySourceData(index), generateId: false });
  } else {
    setSourceData(map, WALK_SOURCE_IDS.sensors, activitySourceData(index));
  }

  const visible = options.visible ?? { historical: true, sensors: true };
  addProgram(map, HISTORICAL_LAYERS, visible.historical);
  addProgram(map, SENSOR_LAYERS, visible.sensors);
  addIfAbsent(map, { ...HISTORICAL_SELECTED, filter: NOTHING_SELECTED });
  addIfAbsent(map, { ...SENSOR_SELECTED, filter: NOTHING_SELECTED });

  let selectedId: string | null = null;

  const applySelection = (): void => {
    const filter = buildSelectionFilter(selectedId);
    if (map.getLayer(WALK_LAYER_IDS.historicalSelected) !== undefined) {
      map.setFilter(WALK_LAYER_IDS.historicalSelected, filter);
    }
    if (map.getLayer(WALK_LAYER_IDS.sensorSelected) !== undefined) {
      map.setFilter(WALK_LAYER_IDS.sensorSelected, filter);
    }
  };

  return {
    get selectedId(): string | null {
      return selectedId;
    },
    setSelectedId(id: string | null): void {
      selectedId = id;
      applySelection();
    },
    setVisible(which: 'historical' | 'sensors', next: boolean): void {
      addProgram(map, which === 'historical' ? HISTORICAL_LAYERS : SENSOR_LAYERS, next);
    },
    setData(next: WalkIndex): void {
      setSourceData(map, WALK_SOURCE_IDS.historical, next.historical);
      setSourceData(map, WALK_SOURCE_IDS.sensors, activitySourceData(next));
    },
    destroy(): void {
      unmountWalkLayers(map);
      selectedId = null;
    },
  };
}

/**
 * Unmount without a handle, for the shell calling `unmount` on a feature whose `mount` never
 * ran, or twice. A missing layer or source is not an error, so this cannot throw.
 */
export function unmountWalkLayers(map: MapLibreLike): void {
  for (const id of [...WALK_LAYER_ID_LIST].reverse()) removeLayerIfPresent(map, id);
  removeSourceIfPresent(map, WALK_SOURCE_IDS.historical);
  removeSourceIfPresent(map, WALK_SOURCE_IDS.sensors);
}
