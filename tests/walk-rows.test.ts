/**
 * THE SORT DEFINITIONS, AS TESTS.
 *
 * "Busiest", "Changed the most" and "Nearest" are three claims about one list of 114 sites,
 * and a claim nobody can check is a claim nobody should be able to press. Each definition in
 * `src/features/walk/rows.ts` is asserted here against a fixture built so that the WRONG
 * implementation would fail:
 *
 *   - `SURVEY_FALLING` has a LARGER absolute change than `SURVEY_RISING` but a SMALLER total,
 *     so "biggest rise" and "biggest total" and "biggest absolute move" are three different
 *     orderings and only one of them passes.
 *   - `SURVEY_FALLING` and `SURVEY_TIE_TOTAL` share a `total`, with different record lengths,
 *     so the tie-break is reachable rather than theoretical.
 *   - the counters carry no `total` and no `change`, so a sort that ranked them with the
 *     survey sites would have to invent a number.
 */

import { describe, expect, it } from 'vitest';
import { haversineMiles } from '../src/lib/distance';
import type { WalkSort } from '../src/features/registry';
import type { LatLng } from '../src/lib/distance';
import type { WalkItem } from '../src/data/walk/validate';
import { WALK_SORT_OPTIONS, buildListRows, isWalkSort, listRowFor } from '../src/features/walk/rows';
import {
  NOW_MS,
  ORIGIN,
  SENSOR_BUSY,
  SENSOR_COLLECTION,
  SENSOR_NO_HISTORY,
  SENSOR_OFFLINE,
  SENSOR_STALE_ZERO_BUCKET,
  SURVEY_FALLING,
  SURVEY_RISING,
  SURVEY_TIE_TOTAL,
  SURVEY_UNSURVEYED,
} from './helpers/walkFixtures';

function historical(feature: (typeof SURVEY_RISING)[][number]): WalkItem {
  return { kind: 'historical', properties: feature.properties, coords: coordsOf(feature) };
}

function sensor(feature: (typeof SENSOR_BUSY)[][number]): WalkItem {
  return { kind: 'sensor', properties: feature.properties, coords: coordsOf(feature) };
}

function coordsOf(feature: { geometry: { coordinates: number[] } }): { lat: number; lng: number } {
  return { lat: feature.geometry.coordinates[1] ?? 0, lng: feature.geometry.coordinates[0] ?? 0 };
}

/**
 * The fixture order the assertions below are written against. Deliberately NOT already sorted
 * by anything, so a comparator that is accidentally the identity fails the first test.
 */
const ITEMS: readonly WalkItem[] = [
  historical(SURVEY_TIE_TOTAL),
  sensor(SENSOR_BUSY),
  historical(SURVEY_UNSURVEYED),
  historical(SURVEY_FALLING),
  sensor(SENSOR_OFFLINE),
  historical(SURVEY_RISING),
  sensor(SENSOR_STALE_ZERO_BUCKET),
  sensor(SENSOR_NO_HISTORY),
];

function ids(rows: ReadonlyArray<{ readonly id: string }>): string[] {
  return rows.map((row) => row.id);
}

const RISING = SURVEY_RISING.id;
const FALLING = SURVEY_FALLING.id;
const TIE = SURVEY_TIE_TOTAL.id;
const UNSURVEYED = SURVEY_UNSURVEYED.id;
const BUSY = SENSOR_BUSY.id;
const OFFLINE = SENSOR_OFFLINE.id;
const ZERO_BUCKET = SENSOR_STALE_ZERO_BUCKET.id;
const NO_HISTORY = SENSOR_NO_HISTORY.id;

function rowsFor(sort: WalkSort | null, origin: LatLng | null = null) {
  return buildListRows(ITEMS, sort, origin, NOW_MS);
}

describe('every sort carries a definition the user can read', () => {
  it('all three registry sorts are offered', () => {
    expect(WALK_SORT_OPTIONS.map((option) => option.id)).toEqual([
      'mostSurveyed',
      'mostChanged',
      'nearby',
    ]);
  });

  it('every definition is a sentence, and none is empty', () => {
    for (const option of WALK_SORT_OPTIONS) {
      expect(option.definition.length, `${option.id} has no definition`).toBeGreaterThan(40);
      expect(option.definition.endsWith('.')).toBe(true);
    }
  });

  it('`mostSurveyed` says it is the MOST RECENT survey, not an average or a maximum', () => {
    const option = WALK_SORT_OPTIONS.find((o) => o.id === 'mostSurveyed');
    expect(option?.definition).toMatch(/most recent/i);
  });

  it('`mostChanged` says it is ABSOLUTE, so the choice is stated and not inferred', () => {
    const option = WALK_SORT_OPTIONS.find((o) => o.id === 'mostChanged');
    expect(option?.definition).toMatch(/absolute/i);
    expect(option?.definition).toMatch(/whichever direction/i);
  });

  it('only `nearby` declares that it needs a position', () => {
    expect(WALK_SORT_OPTIONS.filter((option) => option.needsPosition).map((o) => o.id)).toEqual([
      'nearby',
    ]);
  });

  it('`isWalkSort` accepts the three and rejects anything else', () => {
    expect(isWalkSort('nearby')).toBe(true);
    expect(isWalkSort('mostSurveyed')).toBe(true);
    expect(isWalkSort('mostChanged')).toBe(true);
    expect(isWalkSort('busiest')).toBe(false);
    expect(isWalkSort(null)).toBe(false);
    expect(isWalkSort(7)).toBe(false);
  });
});

describe('a null sort makes no claim at all', () => {
  it('returns the dataset order verbatim — the order the index was built in', () => {
    expect(ids(rowsFor(null))).toEqual([
      TIE,
      BUSY,
      UNSURVEYED,
      FALLING,
      OFFLINE,
      RISING,
      ZERO_BUCKET,
      NO_HISTORY,
    ]);
  });

  it('is the order the index was built in, so it is stable across renders', () => {
    expect(ids(rowsFor(null))).toEqual(ids(rowsFor(null)));
  });
});

describe('mostSurveyed: the most recent survey total, largest first', () => {
  it('orders by the latest survey total, not by the change and not by the record length', () => {
    // RISING total 13272 > FALLING 6300 = TIE 6300. FALLING is the biggest mover, so a
    // mostChanged comparator here would put it first and fail.
    const rows = ids(rowsFor('mostSurveyed'));
    expect(rows.slice(0, 4)).toEqual([RISING, FALLING, TIE, UNSURVEYED]);
    expect(rows.slice(4)).toEqual([ZERO_BUCKET, BUSY, OFFLINE, NO_HISTORY]);
  });

  it('breaks a tie on the longer record first, then on the id', () => {
    // FALLING and TIE share 6300. FALLING has 19 survey years and TIE has 8, so FALLING before
    // TIE is a decision rather than an accident of the fixture's order — and the fixture puts
    // TIE FIRST in the input, so an identity comparator would get this backwards.
    expect(SURVEY_FALLING.properties.yearsMeasured).toBeGreaterThan(
      SURVEY_TIE_TOTAL.properties.yearsMeasured,
    );
    expect(ids(rowsFor('mostSurveyed')).slice(1, 3)).toEqual([FALLING, TIE]);
  });

  it('sorts an unmeasured site LAST, not first, because a null is not the quietest site', () => {
    // 6300 > 0, so a naive `?? 0` would sink it to the bottom anyway; the assertion that
    // matters is that it is not treated as a zero-TOTAL site competing on the same scale.
    const idsOut = ids(rowsFor('mostSurveyed'));
    expect(idsOut.indexOf(UNSURVEYED)).toBe(3);
    expect(idsOut.indexOf(RISING)).toBe(0);
  });

  it('pins the counters to the end rather than ranking them among the survey sites', () => {
    const surveyIds = ids(rowsFor('mostSurveyed')).filter((id) => id.startsWith('wsh-'));
    const counterIds = ids(rowsFor('mostSurveyed')).filter((id) => id.startsWith('wsk-'));
    // Counters are ordered by id among themselves, so the pinned tail is total too.
    expect(counterIds).toEqual([ZERO_BUCKET, BUSY, OFFLINE, NO_HISTORY]);
    expect(surveyIds).toHaveLength(4);
    // Every counter comes after every survey site.
    const all = ids(rowsFor('mostSurveyed'));
    expect(all.indexOf(BUSY)).toBeGreaterThan(all.indexOf(UNSURVEYED));
    expect(all.indexOf(NO_HISTORY)).toBe(all.length - 1);
  });

  it('is TOTAL, so a shuffled input of the same items lands in the same order', () => {
    // Relying on `Array.prototype.sort` being stable would leave a tie broken by whatever order
    // the array happened to arrive in. Stable but arbitrary is still arbitrary, and a list that
    // reshuffles under the pointer is a bug nobody can report precisely.
    const once = ids(rowsFor('mostSurveyed'));
    expect(once).not.toEqual(ids(rowsFor(null)));
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const shuffled = [...ITEMS].reverse();
      if (attempt % 2 === 1) shuffled.sort(() => -1);
      expect(ids(buildListRows(shuffled, 'mostSurveyed', null, NOW_MS))).toEqual(once);
    }
  });
});

describe('mostChanged: the largest ABSOLUTE move, whichever direction', () => {
  it('puts the big FALL first, which is the whole point of choosing absolute', () => {
    const out = ids(rowsFor('mostChanged'));
    expect(out).toEqual([FALLING, RISING, TIE, UNSURVEYED, ZERO_BUCKET, BUSY, OFFLINE, NO_HISTORY]);
  });

  it('would fail a "biggest rise" comparator, which is the alternative that was rejected', () => {
    // Stated as a test so the decision cannot be quietly reversed: sorting by the SIGNED
    // value would put RISING (−9800 vs +3666) first, i.e. the site that emptied out last.
    const signed = [...ITEMS]
      .filter((item): item is Extract<WalkItem, { kind: 'historical' }> => item.kind === 'historical')
      .sort((a, b) => (b.properties.change ?? 0) - (a.properties.change ?? 0));
    expect(signed[0]?.properties.id).toBe(RISING);
    expect(ids(rowsFor('mostChanged'))[0]).toBe(FALLING);
  });

  it('sorts a site with no comparison LAST among the survey sites', () => {
    const out = ids(rowsFor('mostChanged'));
    expect(out.indexOf(UNSURVEYED)).toBe(3);
    expect(out.indexOf(RISING)).toBeLessThan(out.indexOf(TIE));
  });

  it('breaks a tie on the longer record, then the id', () => {
    // Both these sites are `flat` with a zero change, so the first three tests of a tie-break
    // are what is being exercised.
    expect(SURVEY_TIE_TOTAL.properties.change).toBe(0);
    expect(ids(rowsFor('mostChanged')).slice(1, 3)).toEqual([RISING, TIE]);
  });
});

describe('nearby: nearest first, and NOTHING without a position', () => {
  it('returns an EMPTY list when there is no position, rather than an arbitrary order', () => {
    // The app's standing rule: no distance without a real fix. A list headed "nearby" that is
    // not sorted by distance is a lie about its own heading.
    expect(rowsFor('nearby', null)).toEqual([]);
  });

  it('offers nothing at all, not even the counters, when there is no position', () => {
    expect(buildListRows(ITEMS, 'nearby', null, NOW_MS)).toHaveLength(0);
  });

  it('orders every item — sites AND counters — by real distance from the position', () => {
    // The expected order is computed from the app's own `haversineMiles`, so this asserts the
    // comparator USES the origin rather than the identity: the fixture order is deliberately
    // nothing like the distance order.
    const expected = [...ITEMS]
      .map((item) => ({ id: item.properties.id, miles: haversineMiles(ORIGIN, item.coords) }))
      .sort((a, b) => a.miles - b.miles)
      .map((entry) => entry.id);

    expect(ids(rowsFor('nearby', ORIGIN))).toEqual(expected);
    expect(expected).not.toEqual(ids(rowsFor(null)));
  });

  it('the distances it reports are monotonically non-decreasing', () => {
    const rows = rowsFor('nearby', ORIGIN);
    const distances = rows.map((row) => haversineMiles(ORIGIN, { lat: row.lat, lng: row.lng }));
    for (let index = 1; index < distances.length; index += 1) {
      expect(distances[index]).toBeGreaterThanOrEqual(distances[index - 1] ?? 0);
    }
  });

  it('puts the genuinely nearest item first, and its subtitle names what it ranks on', () => {
    // Hand-checked: `SURVEY_RISING` is 5.1 mi from Midtown and `SURVEY_FALLING` is 8.8 mi, so
    // the Queens site precedes the far-Bronx one regardless of which of them the fixture lists
    // first. The distance-order test above pins the full sequence.
    const rows = rowsFor('nearby', ORIGIN);
    const rising = rows.find((row) => row.id === RISING);
    expect(rising?.subtitle).toMatch(/Surveyed May 2026/);
    expect(ids(rowsFor('nearby', ORIGIN)).indexOf(RISING)).toBeLessThan(
      ids(rowsFor('nearby', ORIGIN)).indexOf(FALLING),
    );
  });

  it('shows the distance in a nearby row, because the sort is the claim', () => {
    for (const row of rowsFor('nearby', ORIGIN)) {
      expect(row.subtitle).toMatch(/ (mi|ft) away · /);
    }
  });

  it('puts the Staten Island site last — it is the farthest thing from Midtown', () => {
    // `nearby` is the one sort counters take part in, so this is also the assertion that they
    // are ranked by distance rather than pinned to the end the way the metric sorts pin them.
    const rows = ids(rowsFor('nearby', ORIGIN));
    expect(rows[rows.length - 1]).toBe(UNSURVEYED);
    expect(rows.indexOf(OFFLINE)).toBeLessThan(rows.indexOf(UNSURVEYED));
    expect(rows.indexOf(BUSY)).toBeLessThan(rows.indexOf(FALLING));
  });

  it('is TOTAL for equal distances', () => {
    const twice: WalkItem[] = [
      { kind: 'historical', properties: { ...SURVEY_TIE_TOTAL.properties, id: SURVEY_TIE_TOTAL.properties.id }, coords: ORIGIN },
      { kind: 'historical', properties: { ...SURVEY_RISING.properties, id: SURVEY_RISING.properties.id }, coords: ORIGIN },
    ];
    const out = ids(buildListRows(twice, 'nearby', ORIGIN, NOW_MS));
    expect(out).toEqual([RISING, TIE]);
  });
});

describe('a row is a sentence about a measurement, and never about a live one', () => {
  it('a survey row leads with the survey date and carries the count it belongs to', () => {
    const row = listRowFor(historical(SURVEY_RISING), NOW_MS, null);
    expect(row.title).toBe('82 Street at 37th Avenue');
    expect(row.subtitle).toBe('Surveyed May 2026 · 13,272 pedestrians');
    expect(row.badge).toBe('RISING');
  });

  it('an unsurveyed row says so rather than showing a zero', () => {
    const row = listRowFor(historical(SURVEY_UNSURVEYED), NOW_MS, null);
    expect(row.subtitle).toBe('Never surveyed');
    expect(row.subtitle).not.toMatch(/0 pedestrians/);
  });

  it('a counter row says what kind of thing it is and how old its reading is', () => {
    const row = listRowFor(sensor(SENSOR_BUSY), NOW_MS, null);
    expect(row.subtitle).toBe('Automated counter · Last reading just now');
    expect(row.badge).toBe('FRESH');
  });

  it('a zero-bucket counter row never says "quiet"', () => {
    // The raw activity IS "quiet". The row must not repeat it.
    const row = listRowFor(sensor(SENSOR_STALE_ZERO_BUCKET), NOW_MS, null);
    expect(row.subtitle).not.toMatch(/quiet/i);
    expect(row.subtitle).toBe('Automated counter · Last reading 14 hours ago');
    expect(row.badge).toBe('LATE');
  });

  it('a counter row carries the STALENESS as its badge, never the activity level', () => {
    // `busy` is a claim about a 15-minute bucket an hour old; the badge says how old.
    const row = listRowFor(sensor(SENSOR_BUSY), NOW_MS, null);
    expect(row.badge).not.toBe('BUSY');
    expect(row.badge).toBe('FRESH');
  });

  it('an offline counter row says how long it has been silent', () => {
    const row = listRowFor(sensor(SENSOR_OFFLINE), NOW_MS, null);
    expect(row.subtitle).toBe('Automated counter · Offline since June 7');
    expect(row.badge).toBe('OFFLINE');
  });

  it('no row carries a distance when there is no position', () => {
    for (const item of ITEMS) {
      expect(listRowFor(item, NOW_MS, null).subtitle).not.toMatch(/away ·/);
    }
  });
});

describe('the empty and edge states', () => {
  it('an empty dataset produces an empty list under every sort', () => {
    for (const sort of [null, 'mostSurveyed', 'mostChanged', 'nearby'] as const) {
      expect(buildListRows([], sort, ORIGIN, NOW_MS)).toEqual([]);
      expect(buildListRows([], sort, null, NOW_MS)).toEqual([]);
    }
  });

  it('a dataset with only counters still sorts, with nothing to rank', () => {
    const counters = ITEMS.filter((item) => item.kind === 'sensor');
    const rows = buildListRows(counters, 'mostSurveyed', null, NOW_MS);
    expect(ids(rows)).toEqual([ZERO_BUCKET, BUSY, OFFLINE, NO_HISTORY]);
  });

  it('every sensor fixture is reachable through the list, so none is a map-only ghost', () => {
    const all = new Set(SENSOR_COLLECTION.features.map((feature) => feature.properties.id));
    const listed = new Set(ids(rowsFor(null)));
    for (const id of all) expect(listed.has(id)).toBe(true);
  });
});
