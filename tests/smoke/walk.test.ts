/**
 * Smoke test: the REAL published walk artifacts, through the REAL loader, into the REAL
 * feature — and the numbers the app is about.
 *
 * The reason this file exists is the same reason `tests/smoke/build.test.ts` does, and it is
 * a gap the fixtures cannot close. Every other walk test feeds `tests/helpers/walkFixtures.ts`
 * through a mocked `fetch`, which proves the code works on data shaped like the data. It does
 * not prove the SHIPPED artifacts are shaped like that, that the pipeline's own counters
 * agree with what the app counts, or — the failure this file was written after — that the
 * feature the shell actually mounts is the real one and not a placeholder that would pass
 * every test in the suite while the map stayed empty.
 *
 * So: read the four files under `public/data/walk/` off disk, hand them to `loadWalk`
 * through a `fetch` that serves them, build the feature the catalog builds, and count.
 *
 * THE NUMBERS ARE CROSS-CHECKED AGAINST `data/processed/walk/report.json`, which is the
 * pipeline's own account of what it published. If the app and the pipeline ever disagree
 * about how many count sites there are, this fails and it should: the app's whole promise is
 * that every number on screen came from a named column in a named dataset, and a count the
 * pipeline did not produce is a count nobody can trace.
 *
 * The ONE number that is written down rather than derived — 114 — is the number the feature
 * is about, and it is what a reader of the docs will check. It comes from
 * `report.history.publishedLocations`; the `expect(...).toBe(114)` is the tripwire that says
 * "if this changes, the documentation, the legend note and the product description all
 * change with it, on purpose".
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { FeatureData, FeatureRowsQuery } from '../../src/features/registry';
import type { HistoricalCollection, SensorCollection } from '../../src/types/walk';
import { loadWalk } from '../../src/data/walk/load';
import { walkFeatureSource } from '../../src/data/walk/source';
import type { WalkItem } from '../../src/data/walk/validate';
import { walkProvenance } from '../../src/data/walk/useWalkData';
import { createWalkFeature } from '../../src/features/walk/feature';
import { WALK_LAYER_ID_LIST } from '../../src/features/walk/layers';
import { createWalkMap } from '../helpers/walkMap';

const ROOT = resolve(__dirname, '../..');
const PUBLIC = resolve(ROOT, 'public/data/walk');
const REPORT = resolve(ROOT, 'data/processed/walk/report.json');

/** The whole city, so the list is not clipped: this test is about the dataset, not the camera. */
const CITY = { west: -74.3, south: 40.4, east: -73.65, north: 41.0 };

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

/** A `fetch` that answers only the four walk artifacts, from disk. */
function diskFetch(url: string): Response {
  const name = url.split('/').pop() ?? '';
  const body = readJson<unknown>(resolve(PUBLIC, name));
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}

interface WalkReport {
  readonly history: {
    readonly publishedLocations: number;
    readonly publishedSurveys: number;
    readonly trends: Readonly<Record<string, number>>;
    readonly boroughs: Readonly<Record<string, number>>;
  };
}

interface Real {
  readonly feature: ReturnType<typeof createWalkFeature>;
  readonly historical: HistoricalCollection;
  readonly sensors: SensorCollection;
  readonly report: WalkReport;
  /** What `useWalkData` would put in `data.provenance`, computed from the same artifacts. */
  readonly provenance: string | null;
}

/** One load, shared by the seven tests below, because 4 100 surveys is not a small file. */
let cached: Real | null = null;

async function loaded(): Promise<Real> {
  if (cached !== null) return cached;
  const walk = await loadWalk({
    fetchImpl: (async (input: RequestInfo | URL) => diskFetch(String(input))) as typeof fetch,
    baseUrl: '/',
  });
  const data: FeatureData<WalkItem> = {
    status: 'ready',
    items: walk.items,
    byId: walk.byId,
    error: null,
    retry: () => undefined,
    // The real one is computed by the hook, from `latestObservation`; see below.
    provenance: null,
  };
  cached = {
    feature: createWalkFeature(data, walkFeatureSource(walk)),
    historical: walk.historical,
    sensors: walk.sensors,
    report: readJson<WalkReport>(REPORT),
    provenance: walkProvenance(walk, Date.parse('2026-09-28T19:56:42Z')),
  };
  return cached;
}

function rows(feature: ReturnType<typeof createWalkFeature>) {
  const query: FeatureRowsQuery<unknown> = {
    filters: undefined,
    bounds: CITY,
    origin: null,
    sort: null,
    // The shell's cap is 60; this test wants the whole city, so it asks for it explicitly.
    limit: 10_000,
  };
  return feature.rows(query);
}

describe('the published walk artifacts, through the real loader', () => {
  it('validates, and the counts agree with the pipeline\'s own report', async () => {
    const { historical, sensors, report } = await loaded();

    expect(historical.features.length).toBe(114);
    expect(historical.features.length).toBe(report.history.publishedLocations);
    expect(sensors.features.length).toBe(4);
    // Two DIFFERENT programs, and the loader never merges them.
    expect(historical.features.length + sensors.features.length).toBe(118);
  });

  it('puts every one of them in the list, in the feature\'s own order', async () => {
    const { feature } = await loaded();
    const answer = rows(feature);

    expect(answer.total).toBe(118);
    expect(answer.rows).toHaveLength(118);
    // The shell's noun, which is what a reader of the heading is actually counting.
    expect(feature.nouns).toEqual({ one: 'count site', many: 'count sites' });
    // A survey total and a counter total are not comparable, so `mostSurveyed` pins every
    // counter to the end rather than ranking one among the other.
    const order: string[] = answer.rows.map((row) => row.id);
    const lastSurvey = order.reduce(
      (last, id, index) => (id.startsWith('wsh-') ? index : last),
      -1,
    );
    expect(order.slice(lastSurvey + 1).every((id: string) => id.startsWith('wsk-'))).toBe(true);
  });

  it('reports the whole city in its provenance line, and the date is a survey date', async () => {
    const { feature, report, provenance: line } = await loaded();

    expect(line).toContain(`${report.history.publishedLocations} survey sites`);
    expect(line).toMatch(/newest \w+ 20\d\d/);
    // Not the pipeline's run time, which is the thing this line must never be.
    expect(line).not.toContain('generated');
    expect(feature.identity.attribution).toContain('NYC DOT');
  });

  it('carries the honesty sentence, with the number it is about', async () => {
    const { feature } = await loaded();
    expect(feature.legend.note).toContain('shown only where NYC DOT measured it');
    expect(feature.legend.note).toContain('114 manual survey sites and 4 automated counters');
    expect(feature.legend.swatches).toHaveLength(9);
  });

  it('draws ten layers over both sources, and takes all of them down again', async () => {
    const { feature } = await loaded();
    const map = createWalkMap();
    feature.mount(map);

    expect(map.sourceIds()).toEqual(['wnyc-historical', 'wnyc-sensors']);
    expect([...map.layerIds()].sort()).toEqual([...WALK_LAYER_ID_LIST].sort());
    // The historical source is carrying all 114, not a sample of them.
    const published = map.sourceData('wnyc-historical') as HistoricalCollection;
    expect(published.features.length).toBe(114);

    feature.unmount(map);
    expect(map.layerIds()).toEqual([]);
    expect(map.sourceIds()).toEqual([]);
  });

  it('opens a sheet for a real site, with a discrete series and a date on it', async () => {
    const { feature, historical } = await loaded();
    // A site with a total, so the sheet has a headline and a series to show. `total` is
    // nullable in the contract — a site with no complete survey has none — so the sort
    // treats it as zero rather than assuming it is there.
    const busiest = [...historical.features]
      .sort((a, b) => (b.properties.total ?? 0) - (a.properties.total ?? 0))
      .find((feature) => feature.properties.total !== null);
    expect(busiest).toBeDefined();
    if (busiest === undefined) return;

    const detail = feature.detail(busiest.properties.id);
    expect(detail?.title).toBe(busiest.properties.name);
    expect(detail?.headline).toBe(`Surveyed ${busiest.properties.latestSurvey}`);
    // The load-bearing flag: two DOT surveys are not a line, and `WalkSeriesChart` refuses
    // to draw a series that is not marked discrete.
    expect(detail?.series?.discrete).toBe(true);
    expect(detail?.series?.points.length).toBeGreaterThan(1);
    expect(detail?.caveat).toBeTruthy();
  });

  it('frames the whole dataset, which is what "zoom to all" is for', async () => {
    const { feature } = await loaded();
    const box = feature.extent({ filters: undefined, bounds: null, origin: null, sort: null });
    expect(box).not.toBeNull();
    expect(box?.west ?? 0).toBeLessThan(-74);
    expect(box?.north ?? 0).toBeGreaterThan(40.8);
  });
});
