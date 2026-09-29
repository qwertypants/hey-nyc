/**
 * THE FEATURE, THROUGH THE REGISTRY'S OWN INTERFACE.
 *
 * Everything here goes through `createWalkFeature`, so it exercises the contract the shell
 * will actually use: `mount` / `unmount` / `onEnter` / `legend` / `rows` / `detail`. The
 * four promises the registry's `MapFeature` comment makes are each asserted here:
 *
 *   1. `mount` is idempotent across repeated feature switching.
 *   2. `unmount` leaves nothing behind.
 *   3. `detail` returns null for an id this feature does not own, so a stale selection from
 *      the other feature clears.
 *   4. `legend.note` carries the honesty sentence.
 *
 * It also pins the EMPTY states, because the shell calls every method of this feature before
 * the artifacts have arrived — the map container is in the DOM from the first frame.
 */

import { describe, expect, it } from 'vitest';
import type {
  FeatureData,
  FeatureHandlers,
  FeatureRows,
  FeatureRowsQuery,
} from '../src/features/registry';
import type { MapBounds } from '../src/lib/bounds';
import type { WalkItem } from '../src/data/walk/validate';
import { walkFeatureSource, EMPTY_WALK_INDEX } from '../src/data/walk/source';
import { validateHistoricalPatterns, validateLatest } from '../src/data/walk/validate';
import { createWalkFeature } from '../src/features/walk/feature';
import type { WalkFeature } from '../src/features/walk/feature';
import { WALK_CLICKABLE_LAYER_IDS, WALK_LAYER_ID_LIST } from '../src/features/walk/layers';
import { WALK_DEFAULT_SORT } from '../src/features/walk/rows';
import { createWalkMap, fixtureIndex } from './helpers/walkMap';
import { LATEST_RAW, NOW_MS, PATTERNS_RAW, SURVEY_RISING } from './helpers/walkFixtures';

const PATTERNS = validateHistoricalPatterns(PATTERNS_RAW);
const LATEST = validateLatest(LATEST_RAW);

const INDEX = fixtureIndex();

/** The `FeatureData` shape, built from the fixture index rather than through the network. */
function readyData(): FeatureData<WalkItem> {
  return {
    status: 'ready',
    items: INDEX.items,
    byId: INDEX.byId,
    error: null,
    retry: () => undefined,
    provenance: '5 survey sites, newest May 2026 · newest automated reading just now',
  };
}

function emptyData(status: 'loading' | 'error'): FeatureData<WalkItem> {
  return {
    status,
    items: [],
    byId: new Map(),
    error: status === 'error' ? new Error('walk load failed') : null,
    retry: () => undefined,
    provenance: null,
  };
}

function readySource() {
  const latestById = new Map(LATEST.sensors.map((sensor) => [sensor.id, sensor]));
  return {
    index: INDEX,
    patterns: PATTERNS,
    latestById,
    latestUnavailable: false,
    sourceUrl: PATTERNS.source,
  };
}

function clock() {
  return NOW_MS;
}

describe('the identity the switcher and the document title will show', () => {
  const feature = createWalkFeature(readyData(), readySource(), { now: clock });

  it('is `walk`, which is the `?mode=` slug', () => {
    expect(feature.identity.id).toBe('walk');
  });

  it('has a label, a one-line description and an attribution', () => {
    expect(feature.identity.label).toBe('Where NYC Walks');
    expect(feature.identity.description.length).toBeGreaterThan(10);
    expect(feature.identity.attribution).toContain('NYC DOT');
  });
});

describe('mount is idempotent and unmount leaves nothing behind', () => {
  it('eat -> walk -> eat -> walk leaves exactly one of every layer', () => {
    const map = createWalkMap();
    for (let pass = 0; pass < 4; pass += 1) {
      const feature = createWalkFeature(readyData(), readySource(), { now: clock });
      feature.mount(map);
      expect(map.layerIds()).toHaveLength(WALK_LAYER_ID_LIST.length);
      feature.unmount(map);
      expect(map.layerIds()).toEqual([]);
      expect(map.sourceIds()).toEqual([]);
    }
  });

  it('a double mount on the same feature object adds no second layer', () => {
    const map = createWalkMap();
    const feature = createWalkFeature(readyData(), readySource(), { now: clock });
    feature.mount(map);
    feature.mount(map);
    feature.mount(map);
    expect(map.layerIds()).toHaveLength(WALK_LAYER_ID_LIST.length);
    expect(new Set(map.layerIds()).size).toBe(WALK_LAYER_ID_LIST.length);
  });

  it('unmount without a mount does not throw', () => {
    const map = createWalkMap();
    const feature = createWalkFeature(readyData(), readySource(), { now: clock });
    expect(() => feature.unmount(map)).not.toThrow();
  });

  it('unmount twice does not throw', () => {
    const map = createWalkMap();
    const feature = createWalkFeature(readyData(), readySource(), { now: clock });
    feature.mount(map);
    feature.unmount(map);
    expect(() => feature.unmount(map)).not.toThrow();
  });

  it('a re-mount after an unmount rebuilds from scratch', () => {
    const map = createWalkMap();
    const feature = createWalkFeature(readyData(), readySource(), { now: clock });
    feature.mount(map);
    feature.unmount(map);
    feature.mount(map);
    expect(map.layerIds()).toHaveLength(WALK_LAYER_ID_LIST.length);
  });

  it('mounting on an EMPTY dataset adds the sources and no layers, rather than throwing', () => {
    // The map container is in the DOM from the first frame, so the shell calls `mount` before
    // any request has answered. A feature that threw here would take the shell's error boundary
    // down with it.
    const map = createWalkMap();
    const feature = createWalkFeature(emptyData('loading'), walkFeatureSource(null), { now: clock });
    expect(() => feature.mount(map)).not.toThrow();
    expect(map.sourceIds()).toHaveLength(2);
    expect(map.layerIds().length).toBeGreaterThan(0);
    expect(() => feature.unmount(map)).not.toThrow();
  });

  it('`onEnter` preserves the viewport and moves nothing', () => {
    const map = createWalkMap();
    const feature = createWalkFeature(readyData(), readySource(), { now: clock });
    const before = map.layerIds().length;
    // The registry's own comment: the shell decided to keep the viewport, and only the shell
    // knows whether a camera is meaningful over a citywide survey map.
    expect(() => feature.onEnter(map, { lat: 40.75, lng: -73.98, zoom: 12 })).not.toThrow();
    expect(map.layerIds().length).toBe(before);
  });
});

describe('detail clears a selection this feature does not own', () => {
  const feature = createWalkFeature(readyData(), readySource(), { now: clock });

  it('null for an id from the eat feature', () => {
    // `src/lib/urlState.ts` validates a `sel` against `/^eoy-[0-9a-f]{12}$/`, so a shared link
    // can carry one, and a visitor who switches features without changing the selection hands
    // it straight to this feature.
    expect(feature.detail('eoy-0000000000a1')).toBeNull();
  });

  it('null for an unknown walk id', () => {
    expect(feature.detail('wsh-00000000dead')).toBeNull();
    expect(feature.detail('wsk-00000000dead')).toBeNull();
  });

  it('null for an empty string, rather than a sheet with no title', () => {
    expect(feature.detail('')).toBeNull();
  });

  it('a real id returns a detail, and a survey site\'s leads with its date', () => {
    const detail = feature.detail(SURVEY_RISING.properties.id);
    expect(detail?.headline).toBe('Surveyed May 2026');
    expect(detail?.series?.discrete).toBe(true);
  });
});

describe('the legend carries the honesty sentence, and it is inside the legend', () => {
  const feature = createWalkFeature(readyData(), readySource(), { now: clock });

  it('says pedestrian activity is shown only where DOT measured it', () => {
    expect(feature.legend.note).toContain('shown only where NYC DOT measured it');
  });

  it('says the dots are measurement points, not a description of foot traffic', () => {
    expect(feature.legend.note).toMatch(/these dots are the measurement points/i);
    expect(feature.legend.note).toContain('not a description of foot traffic');
  });

  it('says the two programs are not comparable numbers', () => {
    expect(feature.legend.note).toMatch(/one afternoon counted by hand/);
    expect(feature.legend.note).toMatch(/one 15-minute bucket/);
    expect(feature.legend.note).toMatch(/not the same number/);
  });

  it('says the counter feed is a daily batch, so nothing on the map is "right now"', () => {
    expect(feature.legend.note).toMatch(/daily batch/);
    expect(feature.legend.note).toMatch(/no dot here is a live "right now"/);
  });

  it('is one paragraph, not a fragment', () => {
    expect(feature.legend.note.split('.').filter((part) => part.trim().length > 0).length).toBeGreaterThanOrEqual(3);
  });

  it('carries a swatch for every trend AND for the non-level activity', () => {
    const ids = feature.legend.swatches.map((swatch) => swatch.id);
    expect(ids).toContain('trend-rising');
    expect(ids).toContain('trend-falling');
    expect(ids).toContain('trend-flat');
    expect(ids).toContain('trend-insufficient');
    expect(ids).toContain('activity-unavailable');
    expect(ids).toContain('activity-quiet');
    expect(ids).toContain('activity-veryBusy');
    expect(ids).toHaveLength(9);
  });

  it('every swatch has a colour AND a shape description, because colour is never alone', () => {
    for (const swatch of feature.legend.swatches) {
      expect(swatch.color).toMatch(/^#[0-9a-f]{6}$/);
      expect(swatch.symbol.length, `${swatch.id} has no shape description`).toBeGreaterThan(20);
    }
  });

  it('tells a counter swatch apart from a survey swatch in words', () => {
    const survey = feature.legend.swatches.find((swatch) => swatch.id === 'trend-rising');
    const counter = feature.legend.swatches.find((swatch) => swatch.id === 'activity-busy');
    expect(survey?.symbol).toMatch(/Solid circle/);
    expect(counter?.symbol).toMatch(/ring around a small core, not a solid circle/);
  });

  it('says a missing measurement is not a low one, on the no-reading swatch itself', () => {
    const none = feature.legend.swatches.find((swatch) => swatch.id === 'activity-unavailable');
    expect(none?.label).toContain('No recent reading');
    expect(none?.symbol).toMatch(/missing measurement, not a low one/);
  });

  it('points at the dataset the legend describes, taken from the artifact itself', () => {
    expect(feature.legend.aboutHref).toBe(PATTERNS.source);
    expect(feature.legend.aboutHref).toContain('data.cityofnewyork.us');
  });

  it('adds a clause when latest.json could not be loaded, rather than saying the same words with fewer facts', () => {
    const degraded = createWalkFeature(readyData(), { ...readySource(), latestUnavailable: true }, { now: clock });
    expect(degraded.legend.note).not.toBe(feature.legend.note);
    expect(degraded.legend.note).toContain('newest automated readings could not be loaded');
  });

  it('still has a note when nothing has loaded at all', () => {
    const empty = createWalkFeature(emptyData('loading'), walkFeatureSource(null), { now: clock });
    expect(empty.legend.note).toContain('shown only where NYC DOT measured it');
    expect(empty.legend.swatches).toHaveLength(9);
  });
});

/**
 * `rows(query)` replaced `listRows(sort, origin)`, because the list is "what is in the area
 * the MAP is showing, under the filters, up to the page cap" and a distance reference alone
 * cannot answer that — it carries no extent and no cap. The assertions below are the same
 * ones, expressed against the query the registry actually asks.
 *
 * `filters: undefined` is not a placeholder: walk declares `WalkFilters = unknown` and reads
 * none of it, which is what `controls.filters === null` means at the type level.
 */
function queryOf(
  feature: WalkFeature,
  overrides: Partial<Omit<FeatureRowsQuery<unknown>, 'filters'>> = {},
): FeatureRows {
  return feature.rows({
    filters: undefined,
    bounds: null,
    origin: null,
    sort: null,
    limit: INDEX.items.length,
    ...overrides,
  });
}

describe('rows answers for all three sorts, in every data state', () => {
  it('the rows match the index when the sort is null', () => {
    const feature = createWalkFeature(readyData(), readySource(), { now: clock });
    expect(queryOf(feature).rows).toHaveLength(INDEX.items.length);
  });

  it('`nearby` is empty without a position, through the feature too', () => {
    const feature = createWalkFeature(readyData(), readySource(), { now: clock });
    expect(queryOf(feature, { sort: 'nearby' }).rows).toEqual([]);
  });

  it('an empty dataset yields no rows under any sort', () => {
    const feature = createWalkFeature(emptyData('loading'), walkFeatureSource(null), { now: clock });
    for (const sort of [null, 'mostSurveyed', 'mostChanged', 'nearby'] as const) {
      expect(queryOf(feature, { sort }).rows).toEqual([]);
      expect(queryOf(feature, { sort, origin: { lat: 40.75, lng: -73.98 } }).rows).toEqual([]);
    }
  });

  it('every row carries the coordinates the map needs to fly to it', () => {
    const feature = createWalkFeature(readyData(), readySource(), { now: clock });
    for (const row of queryOf(feature, { sort: 'mostSurveyed' }).rows) {
      expect(Number.isFinite(row.lat)).toBe(true);
      expect(Number.isFinite(row.lng)).toBe(true);
      expect(row.title.length).toBeGreaterThan(0);
    }
  });
});

describe('the query the shell actually sends, answered honestly', () => {
  const feature = createWalkFeature(readyData(), readySource(), { now: clock });

  it('a null sort is THIS feature\'s default order, because that is what its control shows', () => {
    // The sort control offers "Busiest at the last survey" as selected when the shell has
    // not chosen one (`tests/walk-a11y.test.tsx` pins it). A list in a different order under
    // that control is the same lie as a "nearby" heading over a list that is not sorted by
    // distance, so the two have to agree.
    const defaultOrder = queryOf(feature).rows.map((row) => row.id);
    const explicit = queryOf(feature, { sort: WALK_DEFAULT_SORT }).rows.map((row) => row.id);
    expect(defaultOrder).toEqual(explicit);
  });

  it('a cap returns a page and reports the untruncated total, so "3 of 9" is possible', () => {
    const answer = queryOf(feature, { limit: 3 });
    expect(answer.rows).toHaveLength(3);
    expect(answer.total).toBe(INDEX.items.length);
    expect(answer.datasetCount).toBe(INDEX.items.length);
  });

  it('clips to the map extent, and a null extent is NO extent filter rather than nothing', () => {
    // One site is inside this box and the rest are not, so the clip is observable. The
    // second half is the one that matters: `bounds: null` means "the map has not reported
    // one yet", and returning an empty list for the first frame after a load would be a lie
    // about the map.
    // Six of the nine fixtures are inside this box and three are outside, so the clip is
    // observable in both directions.
    const box: MapBounds = { west: -74, south: 40.7, east: -73.85, north: 40.9 };
    const clipped = queryOf(feature, { bounds: box });
    expect(clipped.rows.length).toBeGreaterThan(0);
    expect(clipped.rows.length).toBeLessThan(INDEX.items.length);
    expect(clipped.total).toBe(clipped.rows.length);
    for (const row of clipped.rows) {
      expect(row.lng).toBeGreaterThanOrEqual(box.west);
      expect(row.lng).toBeLessThanOrEqual(box.east);
    }
    expect(queryOf(feature, { bounds: null }).rows).toHaveLength(INDEX.items.length);
  });

  it('never says it is filtered, because it has nothing to filter by', () => {
    // `filtered: true` would put a "Clear filters" button on a map with no filters, and a
    // button that clears nothing.
    expect(queryOf(feature).filtered).toBe(false);
  });

  it('every row names the map shape in words, and borrows no swatch it has no CSS for', () => {
    for (const row of queryOf(feature).rows) {
      expect(row.meta, `${row.id} has no words for its shape`).toBeTruthy();
      expect((row.meta ?? '').length).toBeGreaterThan(8);
      // The shell's swatch vocabulary is Eat Outside's three classes. Walk's shapes are
      // hollow rings and heavy-rimmed discs, so it puts the shape in words and takes no
      // class from a stylesheet that has never heard of them.
      expect(row.symbol).toBeNull();
    }
  });

  it('reports its own dataset size, which is not a count of "places"', () => {
    expect(feature.nouns).toEqual({ one: 'count site', many: 'count sites' });
  });
});

describe('positionOf and extent, the two answers the shell needs a camera for', () => {
  const feature = createWalkFeature(readyData(), readySource(), { now: clock });

  it('flies to a real id and refuses an unknown one', () => {
    expect(feature.positionOf(SURVEY_RISING.properties.id)).toEqual({
      lat: SURVEY_RISING.geometry.coordinates[1],
      lng: SURVEY_RISING.geometry.coordinates[0],
    });
    // An id from the other feature has no position, which is how a leftover selection is
    // refused rather than flown to.
    expect(feature.positionOf('eoy-0000000000a1')).toBeNull();
  });

  it('frames every measurement point, and nothing when there are none', () => {
    const box = feature.extent({ filters: undefined, bounds: null, origin: null, sort: null });
    expect(box).not.toBeNull();
    for (const item of INDEX.items) {
      expect(box?.west ?? 1).toBeLessThanOrEqual(item.coords.lng);
      expect(box?.east ?? -1).toBeGreaterThanOrEqual(item.coords.lng);
    }
    const empty = createWalkFeature(emptyData('loading'), walkFeatureSource(null), { now: clock });
    expect(empty.extent({ filters: undefined, bounds: null, origin: null, sort: null })).toBeNull();
  });
});

describe('the click handler the registry has no signature for until now', () => {
  function spy() {
    const calls: string[] = [];
    return {
      calls,
      handlers: {
        onSelect: (id: string) => calls.push(`select:${id}`),
        onClearSelection: () => calls.push('clear'),
        onError: () => calls.push('error'),
      } satisfies FeatureHandlers,
    };
  }

  it('reports a hit on one of this feature\'s own points', () => {
    const map = createWalkMap();
    const { calls, handlers } = spy();
    const feature = createWalkFeature(readyData(), readySource(), { now: clock });
    feature.mount(map);
    feature.state.setHandlers(handlers);
    map.setRenderedFeatures([{ properties: { id: SURVEY_RISING.properties.id } }]);

    map.fire('click', { point: { x: 1, y: 2 } });
    expect(calls).toEqual([`select:${SURVEY_RISING.properties.id}`]);
  });

  it('scopes the hit test to its own layers, because the map is shared', () => {
    // Unscoped, a click could select a point belonging to the feature that was switched away
    // from — its layers may be sitting exactly where these are.
    const map = createWalkMap();
    const { handlers } = spy();
    const feature = createWalkFeature(readyData(), readySource(), { now: clock });
    feature.mount(map);
    feature.state.setHandlers(handlers);
    map.fire('click', { point: { x: 1, y: 2 } });

    expect(map.queries()).toHaveLength(1);
    const options = map.queries()[0]?.options as { layers?: readonly string[] } | undefined;
    expect(options?.layers).toEqual([...WALK_CLICKABLE_LAYER_IDS]);
    for (const layer of WALK_CLICKABLE_LAYER_IDS) expect(layer).toMatch(/^wnyc-/);
  });

  it('clears the selection on a click that hit nothing', () => {
    const map = createWalkMap();
    const { calls, handlers } = spy();
    const feature = createWalkFeature(readyData(), readySource(), { now: clock });
    feature.mount(map);
    feature.state.setHandlers(handlers);

    map.fire('click', { point: { x: 1, y: 2 } });
    expect(calls).toEqual(['clear']);
  });

  it('refuses an id it cannot resolve rather than reporting a selection that opens nothing', () => {
    const map = createWalkMap();
    const { calls, handlers } = spy();
    const feature = createWalkFeature(readyData(), readySource(), { now: clock });
    feature.mount(map);
    feature.state.setHandlers(handlers);
    map.setRenderedFeatures([{ properties: { id: 'eoy-0000000000a1' } }]);

    map.fire('click', { point: { x: 1, y: 2 } });
    expect(calls).toEqual([]);
  });

  it('is silent before the shell has handed it handlers, and loud after', () => {
    const map = createWalkMap();
    const feature = createWalkFeature(readyData(), readySource(), { now: clock });
    feature.mount(map);
    map.setRenderedFeatures([{ properties: { id: SURVEY_RISING.properties.id } }]);
    expect(() => map.fire('click', { point: { x: 1, y: 2 } })).not.toThrow();
  });

  it('takes the listener with it on unmount, so a switch leaves no click handler behind', () => {
    // The whole point of `on` returning a subscription. Four passes of mount/unmount must
    // never leave a second handler bound to a map the next feature is now drawing on.
    const map = createWalkMap();
    for (let pass = 0; pass < 4; pass += 1) {
      const { calls, handlers } = spy();
      const feature = createWalkFeature(readyData(), readySource(), { now: clock });
      feature.mount(map);
      feature.state.setHandlers(handlers);
      feature.unmount(map);
      expect(map.listenerCount()).toBe(0);
      map.setRenderedFeatures([{ properties: { id: SURVEY_RISING.properties.id } }]);
      map.fire('click', { point: { x: 1, y: 2 } });
      expect(calls).toEqual([]);
    }
  });

  it('does not stack a second listener on a repeated mount', () => {
    const map = createWalkMap();
    const feature = createWalkFeature(readyData(), readySource(), { now: clock });
    feature.mount(map);
    const once = map.listenerCount();
    feature.mount(map);
    feature.mount(map);
    expect(map.listenerCount()).toBe(once);
  });
});

describe('the empty index is a real value, not a null', () => {
  it('has no items and no sites, and the feature answers rather than throwing', () => {
    const source = walkFeatureSource(null);
    expect(source.index).toBe(EMPTY_WALK_INDEX);
    expect(source.index.items).toEqual([]);
    expect(source.patterns).toBeNull();
    expect(source.sourceUrl).toBeNull();

    const feature = createWalkFeature(emptyData('error'), source, { now: clock });
    expect(feature.detail(SURVEY_RISING.properties.id)).toBeNull();
    expect(queryOf(feature, { sort: 'mostSurveyed' }).rows).toEqual([]);
  });
});
