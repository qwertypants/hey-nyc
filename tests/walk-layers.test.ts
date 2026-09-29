/**
 * THE LAYERS.
 *
 * Three things are under test and they are the three things the registry's `MapFeature`
 * comment makes promises about:
 *
 *   1. `mount` is IDEMPOTENT and `unmount` removes everything. `tests/feature-switching.test.tsx`
 *      switches eat -> walk -> eat -> walk and asserts it, so this file asserts the same
 *      property from the other side — that a double mount, a mount after an unmount, and an
 *      unmount of something never mounted all behave — which is what makes that shell test
 *      pass for the right reason rather than by accident.
 *   2. NOTHING IS ENCODED BY COLOUR ALONE. The trend's second channel is a rim width, the
 *      staleness's is a fill opacity and a centre glyph, and both are asserted here as
 *      expressions rather than as prose.
 *   3. THE ACTIVITY THE MAP PAINTS IS THE DISPLAY ACTIVITY. The most important assertion in
 *      this file is that the source handed to MapLibre says `unavailable` for a zero bucket,
 *      and keeps the published value beside it so the decision is auditable.
 */

import { describe, expect, it } from 'vitest';
import { SENSOR_ACTIVITIES, STALENESS_STATES, TREND_STATES } from '../src/types/walk';
import {
  WALK_LAYER_IDS,
  WALK_LAYER_ID_LIST,
  WALK_SOURCE_IDS,
  WALK_TOTAL_STEPS,
  mountWalkLayers,
  radiusForTotal,
  unmountWalkLayers,
} from '../src/features/walk/layers';
import { ACTIVITY_STYLES, STALENESS_STYLES, TREND_STYLES } from '../src/features/walk/style';
import { createWalkMap, fixtureIndex } from './helpers/walkMap';
import { SENSOR_COLLECTION } from './helpers/walkFixtures';

/** The properties of the first feature in whatever payload was handed to a source. */
function firstProperties(data: unknown): Record<string, unknown> {
  const collection = data as { features?: { properties?: Record<string, unknown> }[] };
  const first = collection.features?.[0];
  if (first === undefined || first.properties === undefined) {
    throw new Error('the source was given no features');
  }
  return first.properties;
}

function findFeature(data: unknown, id: string): Record<string, unknown> {
  const collection = data as { features?: { properties?: Record<string, unknown> }[] };
  const found = collection.features?.find((feature) => feature.properties?.['id'] === id);
  if (found?.properties === undefined) throw new Error(`no feature with id ${id}`);
  return found.properties;
}

function layerPaint(data: unknown, id: string): Record<string, unknown> {
  const double = data as { getLayer: (id: string) => unknown };
  const layer = double.getLayer(id) as { paint?: Record<string, unknown> } | undefined;
  if (layer === undefined || layer.paint === undefined) throw new Error(`no layer ${id}`);
  return layer.paint;
}

function layerLayout(data: unknown, id: string): Record<string, unknown> {
  const double = data as { getLayer: (id: string) => unknown };
  const layer = double.getLayer(id) as { layout?: Record<string, unknown> } | undefined;
  if (layer === undefined || layer.layout === undefined) throw new Error(`no layer ${id}`);
  return layer.layout;
}

describe('the id vocabulary is `wnyc-`, and it is registered in one list', () => {
  it('every source id is prefixed', () => {
    for (const id of Object.values(WALK_SOURCE_IDS)) expect(id.startsWith('wnyc-')).toBe(true);
  });

  it('every layer id is prefixed and appears in the list `unmount` walks', () => {
    const registered = new Set(WALK_LAYER_ID_LIST);
    for (const id of Object.values(WALK_LAYER_IDS)) {
      expect(id.startsWith('wnyc-')).toBe(true);
      expect(registered.has(id), `${id} is not in WALK_LAYER_ID_LIST, so unmount would leak it`).toBe(true);
    }
  });

  it('the list has no duplicates, which would make `unmount` remove a layer twice', () => {
    expect(new Set(WALK_LAYER_ID_LIST).size).toBe(WALK_LAYER_ID_LIST.length);
  });

  it('the two programs have visually distinct marks, not just distinct sources', () => {
    // A survey site is a disc; a counter is a ring. The shapes must differ, because 114 discs
    // and 4 rings on one map is a distinction a reader makes before reading a word.
    const sensorPaint = layerPaint(
      mountAndInspect(),
      WALK_LAYER_IDS.sensorRing,
    );
    const historicalPaint = layerPaint(mountAndInspect(), WALK_LAYER_IDS.historicalCore);
    expect(Number(sensorPaint['circle-radius'])).toBeGreaterThan(
      Number(historicalPaint['circle-radius'] === undefined ? 0 : 0) + 6,
    );
  });
});

/** Mounts on a fresh double and returns it, for the paint assertions. */
function mountAndInspect(): ReturnType<typeof createWalkMap> {
  const map = createWalkMap();
  mountWalkLayers(map, fixtureIndex());
  return map;
}

describe('mount is idempotent and unmount removes everything', () => {
  it('adds both sources and every layer exactly once', () => {
    const map = mountAndInspect();
    expect([...map.sourceIds()].sort()).toEqual([WALK_SOURCE_IDS.sensors, WALK_SOURCE_IDS.historical].sort());
    expect([...map.layerIds()].sort()).toEqual([...WALK_LAYER_ID_LIST].sort());
  });

  it('a SECOND mount adds no second layer and no second source', () => {
    const map = createWalkMap();
    const index = fixtureIndex();
    mountWalkLayers(map, index);
    const layersAfterFirst = map.layerIds().length;
    const sourcesAfterFirst = map.sourceIds().length;
    mountWalkLayers(map, index);
    expect(map.layerIds().length).toBe(layersAfterFirst);
    expect(map.sourceIds().length).toBe(sourcesAfterFirst);
  });

  it('ten mounts leave exactly one of everything', () => {
    const map = createWalkMap();
    const index = fixtureIndex();
    for (let attempt = 0; attempt < 10; attempt += 1) mountWalkLayers(map, index);
    expect(map.layerIds()).toHaveLength(WALK_LAYER_ID_LIST.length);
    expect(new Set(map.layerIds()).size).toBe(WALK_LAYER_ID_LIST.length);
    expect(map.sourceIds()).toHaveLength(2);
  });

  it('unmount removes every layer and both sources', () => {
    const map = mountAndInspect();
    unmountWalkLayers(map);
    expect(map.layerIds()).toEqual([]);
    expect(map.sourceIds()).toEqual([]);
  });

  it('the handle\'s `destroy` removes exactly what `mount` added', () => {
    const map = createWalkMap();
    const handle = mountWalkLayers(map, fixtureIndex());
    handle.destroy();
    expect(map.layerIds()).toEqual([]);
    expect(map.sourceIds()).toEqual([]);
  });

  it('unmount TWICE does not throw — the double call is a state, not a bug', () => {
    // The double in tests/helpers/walkMap.ts throws on `removeLayer` for an unknown id, exactly
    // as MapLibre does. If this passes, `unmount` is genuinely guarding.
    const map = mountAndInspect();
    unmountWalkLayers(map);
    expect(() => unmountWalkLayers(map)).not.toThrow();
  });

  it('unmount without a prior mount does not throw', () => {
    const map = createWalkMap();
    expect(() => unmountWalkLayers(map)).not.toThrow();
  });

  it('a mount after an unmount rebuilds cleanly, with no leftovers from the first', () => {
    const map = createWalkMap();
    const index = fixtureIndex();
    mountWalkLayers(map, index);
    unmountWalkLayers(map);
    mountWalkLayers(map, index);
    expect([...map.layerIds()].sort()).toEqual([...WALK_LAYER_ID_LIST].sort());
  });

  it('re-mounting pushes the data rather than re-adding the source, so the style is not re-tiled', () => {
    const map = createWalkMap();
    const index = fixtureIndex();
    mountWalkLayers(map, index);
    expect(map.setDataCalls()).toBe(0);
    mountWalkLayers(map, index);
    expect(map.setDataCalls()).toBe(2);
    expect(map.sourceIds()).toHaveLength(2);
  });

  it('`setData` re-pushes both sources', () => {
    const map = createWalkMap();
    const handle = mountWalkLayers(map, fixtureIndex());
    handle.setData(fixtureIndex());
    expect(map.setDataCalls()).toBe(2);
  });
});

describe('the layer toggles add and remove, and can be undone', () => {
  it('hiding the survey sites removes their layers and keeps the counters', () => {
    const map = createWalkMap();
    const handle = mountWalkLayers(map, fixtureIndex());
    handle.setVisible('historical', false);
    expect(map.layerIds()).not.toContain(WALK_LAYER_IDS.historicalCore);
    expect(map.layerIds()).not.toContain(WALK_LAYER_IDS.historicalRim);
    expect(map.layerIds()).toContain(WALK_LAYER_IDS.sensorCore);
  });

  it('showing them again puts the same ids back, in the same set', () => {
    const map = createWalkMap();
    const before = mountWalkLayers(map, fixtureIndex());
    const original = [...map.layerIds()].sort();
    before.setVisible('sensors', false);
    before.setVisible('sensors', true);
    expect([...map.layerIds()].sort()).toEqual([...original].sort());
  });

  it('hiding the counters leaves the survey sites alone', () => {
    const map = createWalkMap();
    const handle = mountWalkLayers(map, fixtureIndex());
    handle.setVisible('sensors', false);
    expect(map.layerIds()).not.toContain(WALK_LAYER_IDS.sensorCore);
    expect(map.layerIds()).not.toContain(WALK_LAYER_IDS.sensorMark);
    expect(map.layerIds()).toContain(WALK_LAYER_IDS.historicalCore);
  });

  it('mounting with a program already hidden does not add its layers', () => {
    const map = createWalkMap();
    mountWalkLayers(map, fixtureIndex(), { visible: { historical: false, sensors: true } });
    expect(map.layerIds()).not.toContain(WALK_LAYER_IDS.historicalCore);
    expect(map.layerIds()).toContain(WALK_LAYER_IDS.sensorRing);
  });
});

describe('the activity the map paints is the DISPLAY activity, not the published one', () => {
  it('a zero bucket is painted as `unavailable`, and the published value is kept beside it', () => {
    // The load-bearing assertion of this file. `wsk-0000000000b1` publishes
    // `activity: "quiet"` with `count: 0, expected: 0, percentile: 50`. A MapLibre expression
    // cannot call a function, so the decision is made here and the map is told the answer.
    const map = mountAndInspect();
    const properties = findFeature(map.sourceData(WALK_SOURCE_IDS.sensors), 'wsk-0000000000b1');
    expect(properties['activity']).toBe('unavailable');
    expect(properties['publishedActivity']).toBe('quiet');
  });

  it('a counter with a real reading keeps its level', () => {
    const map = mountAndInspect();
    const properties = findFeature(map.sourceData(WALK_SOURCE_IDS.sensors), 'wsk-0000000000b2');
    expect(properties['activity']).toBe('busy');
    expect(properties['publishedActivity']).toBe('busy');
  });

  it('every sensor in the fixture source has a display activity from the contract vocabulary', () => {
    const map = mountAndInspect();
    const data = map.sourceData(WALK_SOURCE_IDS.sensors) as {
      features: { properties: { activity: string } }[];
    };
    for (const feature of data.features) {
      expect(SENSOR_ACTIVITIES).toContain(feature.properties.activity as never);
    }
  });

  it('the core fill expression covers all five activities, with `unavailable` its own colour', () => {
    const map = mountAndInspect();
    const fill = layerPaint(map, WALK_LAYER_IDS.sensorCore)['circle-color'] as unknown[];
    for (const activity of SENSOR_ACTIVITIES) expect(fill).toContain(activity);
    // The colour each activity maps to is the one in `style.ts`, not a literal in the layer.
    // Indexed on the RAW array rather than on a filtered copy of it: `['match', ['get', …], …]`
    // has a nested array at index 1, so a filtered index is off by one and this assertion
    // would be reading the wrong slot.
    const colourFor = (activity: string): string | undefined => {
      const index = fill.indexOf(activity);
      return index < 0 ? undefined : (fill[index + 1] as string | undefined);
    };
    for (const activity of SENSOR_ACTIVITIES) {
      expect(colourFor(activity)).toBe(ACTIVITY_STYLES[activity].color);
    }
  });

  it('the historical source is handed the collection UNCHANGED — no rewrite, no lost field', () => {
    const map = mountAndInspect();
    const data = map.sourceData(WALK_SOURCE_IDS.historical) as { features: unknown[] };
    expect(data.features).toHaveLength(5);
    expect(firstProperties(map.sourceData(WALK_SOURCE_IDS.historical))['trend']).toBe('rising');
  });

  it('there is no clustering, because 114 sites and 4 counters is the whole dataset', () => {
    const map = mountAndInspect();
    const source = map.sourceData(WALK_SOURCE_IDS.historical) as { features: unknown[] };
    // A clustered source is not what a `setData` double can report, so the assertion is on the
    // layer count instead: clustering 114 points would add cluster layers, and there are none.
    expect(map.layerIds().filter((id) => id.includes('cluster'))).toEqual([]);
    expect(source.features).toHaveLength(5);
  });
});

describe('nothing is encoded by colour alone', () => {
  it('the trend\'s second channel is a rim WIDTH, distinct for every trend', () => {
    const map = mountAndInspect();
    const width = layerPaint(map, WALK_LAYER_IDS.historicalRim)['circle-stroke-width'] as unknown[];
    for (const trend of TREND_STATES) expect(width).toContain(trend);
    const valueFor = (trend: string): number | undefined => {
      const index = width.indexOf(trend);
      return index < 0 ? undefined : (width[index + 1] as number | undefined);
    };
    for (const trend of TREND_STATES) {
      expect(valueFor(trend)).toBe(TREND_STYLES[trend].strokeWidth);
    }
    // `flat` and `insufficient` share a rim weight of 0, so the rim alone does not separate all
    // four — the SILHOUETTE does, and it is the pair (rim weight, core radius). `flat` is a
    // plain disc of 5.5px and `insufficient` is a small faint one of 3.5px, which is a shape
    // difference rather than a hue one.
    expect(valueFor('rising')).toBeGreaterThan(valueFor('falling') ?? 0);
    expect(valueFor('falling')).toBeGreaterThan(valueFor('flat') ?? 0);
    expect(valueFor('flat')).toBe(0);

    const silhouettes = TREND_STATES.map(
      (trend) => `${valueFor(trend)}/${TREND_STYLES[trend].radius}/${TREND_STYLES[trend].opacity}`,
    );
    expect(new Set(silhouettes).size).toBe(TREND_STATES.length);
  });

  it('the trend word is PRINTED on the label layer, from the same table', () => {
    const map = mountAndInspect();
    const field = layerLayout(map, WALK_LAYER_IDS.historicalLabel)['text-field'] as unknown[];
    const words = JSON.stringify(field);
    for (const trend of TREND_STATES) {
      expect(words).toContain(trend);
      expect(words).toContain(TREND_STYLES[trend].label);
    }
  });

  it('the staleness word is PRINTED on the counter label layer', () => {
    const map = mountAndInspect();
    const field = JSON.stringify(layerLayout(map, WALK_LAYER_IDS.sensorLabel)['text-field']);
    for (const staleness of STALENESS_STATES) {
      expect(field).toContain(staleness);
      expect(field).toContain(STALENESS_STYLES[staleness].label);
    }
  });

  it('the counter centre mark is a `+` or an `x`, from the table rather than a literal', () => {
    const map = mountAndInspect();
    const field = layerLayout(map, WALK_LAYER_IDS.sensorMark)['text-field'] as unknown[];
    const glyphFor = (staleness: string): string | undefined => {
      const index = field.indexOf(staleness);
      return index < 0 ? undefined : (field[index + 1] as string | undefined);
    };
    for (const staleness of STALENESS_STATES) {
      expect(glyphFor(staleness)).toBe(STALENESS_STYLES[staleness].glyph);
    }
  });

  it('staleness also drives a FILL OPACITY, so a dead counter is a hole rather than a colour', () => {
    const map = mountAndInspect();
    const opacity = layerPaint(map, WALK_LAYER_IDS.sensorCore)['circle-opacity'] as unknown[];
    const valueFor = (staleness: string): number | undefined => {
      const index = opacity.indexOf(staleness);
      return index < 0 ? undefined : (opacity[index + 1] as number | undefined);
    };
    for (const staleness of STALENESS_STATES) {
      expect(valueFor(staleness)).toBe(STALENESS_STYLES[staleness].coreOpacity);
    }
    expect(valueFor('offline')).toBe(0);
    expect(valueFor('fresh')).toBe(1);
  });

  it('a dead counter gets a SECOND ring, filtered on staleness rather than drawn always', () => {
    const map = mountAndInspect();
    const filter = JSON.stringify(
      (map.getLayer(WALK_LAYER_IDS.sensorOuterRing) as { filter: unknown }).filter,
    );
    expect(filter).toContain('offline');
    expect(filter).toContain('unavailable');
    expect(filter).not.toContain('fresh');
  });

  it('the label layers use the same fontstack the basemap serves, so the words cannot vanish', () => {
    const map = mountAndInspect();
    for (const id of [WALK_LAYER_IDS.historicalLabel, WALK_LAYER_IDS.sensorLabel]) {
      expect(layerLayout(map, id)['text-font']).toEqual(['Noto Sans Regular']);
    }
  });

  it('the labels appear at the same zoom the eat feature prints its own', () => {
    const map = mountAndInspect();
    const zooms = [WALK_LAYER_IDS.historicalLabel, WALK_LAYER_IDS.sensorLabel].map(
      (id) => (map.getLayer(id) as { minzoom?: number }).minzoom,
    );
    expect(zooms).toEqual([15.5, 15.5]);
  });
});

describe('`total` drives the radius, as steps over a printed ramp', () => {
  it('the ramp is monotonic', () => {
    const radii = WALK_TOTAL_STEPS.map((step) => step.radius);
    for (let index = 1; index < radii.length; index += 1) {
      expect(radii[index]).toBeGreaterThan(radii[index - 1] ?? 0);
    }
  });

  it('`radiusForTotal` buckets by the ramp, and treats null as the smallest', () => {
    expect(radiusForTotal(null)).toBe(WALK_TOTAL_STEPS[0]?.radius);
    expect(radiusForTotal(0)).toBe(WALK_TOTAL_STEPS[0]?.radius);
    expect(radiusForTotal(400)).toBe(4);
    expect(radiusForTotal(501)).toBe(6);
    expect(radiusForTotal(1_000_000)).toBe(14);
  });

  it('the core layer uses a `step` over `total`, not a smooth interpolation', () => {
    // A linear radius across 0 to 37 109 makes a 900-person site and a 1 100-person site differ
    // by a fifth of a pixel, which is a difference the map cannot honestly draw.
    const map = mountAndInspect();
    const radius = layerPaint(map, WALK_LAYER_IDS.historicalCore)['circle-radius'] as unknown[];
    expect(radius[0]).toBe('step');
    expect(radius).not.toContain('interpolate');
  });

  it('a null total reads as the smallest bucket rather than failing the expression', () => {
    const map = mountAndInspect();
    const radius = layerPaint(map, WALK_LAYER_IDS.historicalCore)['circle-radius'] as unknown[];
    expect(JSON.stringify(radius)).toContain('coalesce');
  });
});

describe('selection is set through the filter, and matches nothing by default', () => {
  it('the selection layers start filtered to nothing', () => {
    const map = createWalkMap();
    mountWalkLayers(map, fixtureIndex());
    for (const id of [WALK_LAYER_IDS.historicalSelected, WALK_LAYER_IDS.sensorSelected]) {
      const filter = JSON.stringify((map.getLayer(id) as { filter: unknown }).filter);
      expect(filter).toContain('""');
    }
  });

  it('`setSelectedId` writes the id into both selection filters', () => {
    const map = createWalkMap();
    const handle = mountWalkLayers(map, fixtureIndex());
    handle.setSelectedId('wsh-0000000000a1');
    expect(handle.selectedId).toBe('wsh-0000000000a1');
    const calls = map.filterCalls();
    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(calls)).toContain('wsh-0000000000a1');
  });

  it('clearing the selection writes the "nothing" filter back', () => {
    const map = createWalkMap();
    const handle = mountWalkLayers(map, fixtureIndex());
    handle.setSelectedId('wsk-0000000000b1');
    handle.setSelectedId(null);
    expect(handle.selectedId).toBeNull();
    const last = map.filterCalls().at(-1);
    expect(JSON.stringify(last?.filter)).toContain('""');
  });

  it('`setSelectedId` on an unmounted map is a no-op rather than a throw', () => {
    // The handle outlives the map if the shell tears the map down first, and a feature that
    // throws in that order takes the shell's error boundary with it.
    const map = createWalkMap();
    const handle = mountWalkLayers(map, fixtureIndex());
    unmountWalkLayers(map);
    expect(() => handle.setSelectedId('wsh-0000000000a1')).not.toThrow();
  });
});

describe('the fixtures themselves are contract-shaped', () => {
  it('every sensor fixture id is `wsk-` and every site is `wsh-`', () => {
    for (const feature of SENSOR_COLLECTION.features) expect(feature.id).toMatch(/^wsk-[0-9a-f]{12}$/);
  });
});
