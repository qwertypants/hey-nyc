/**
 * Smoke test: the REAL generated dataset, through the REAL runtime validator.
 *
 * Everything else in `tests/` uses inline fixtures, which is right — it keeps unit tests
 * fast and independent of upstream. But it leaves the actual integration untested: that
 * the artifact `scripts/clean_data.py` writes on a maintainer's machine is something the
 * app's own `validateCollection` accepts, and that the two files agree with each other.
 *
 * This is that test. It fails if the pipeline and the app contract ever drift apart, which
 * is the one failure mode that unit tests with fixtures structurally cannot catch.
 *
 * It also checks the built output when `dist/` is present, which is what `npm run verify`
 * and both GitHub workflows produce. `npm test` runs before `npm run build`, so on a clean
 * checkout `dist/` is legitimately absent and that half is skipped rather than failed.
 */

import { existsSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { indexCollection, validateCollection, validateMetadata } from '../../src/data/dataset';
import { DINING_TYPES, BOROUGHS } from '../../src/types/location';

const ROOT = resolve(__dirname, '../..');
const GEOJSON = resolve(ROOT, 'public/data/cafes.geojson');
const METADATA = resolve(ROOT, 'public/data/metadata.json');
const REPORT = resolve(ROOT, 'data/processed/report.json');

/** NYC bounding box, matching scripts/clean_data.py. */
const NYC = { minLat: 40.4, maxLat: 41.0, minLng: -74.3, maxLng: -73.65 };

interface Report {
  sourceRows: number;
  publishedLocations: number;
  mergedSidewalkAndRoadway: number;
  sidewalk: number;
  roadway: number;
  both: number;
  contentHash: string;
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

describe('the published artifact loads in the app', () => {
  it('passes the runtime validator that the app itself uses', () => {
    // Throws DatasetError with a specific message if any feature, property, date, borough
    // or id is off — the same code path a visitor exercises on first paint.
    const collection = validateCollection(readJson(GEOJSON));
    const metadata = validateMetadata(readJson(METADATA));
    expect(collection.type).toBe('FeatureCollection');
    expect(collection.features.length).toBeGreaterThan(1000);
    expect(metadata.recordCount).toBe(collection.features.length);
  });

  it('indexes without id collisions', () => {
    const collection = validateCollection(readJson(GEOJSON));
    const index = indexCollection(collection);
    expect(index.byId.size).toBe(collection.features.length);
    expect(index.coords.size).toBe(collection.features.length);
    expect(index.locations).toHaveLength(collection.features.length);
  });

  it('places every point inside New York City', () => {
    const collection = validateCollection(readJson(GEOJSON));
    for (const feature of collection.features) {
      const [lng, lat] = feature.geometry.coordinates;
      expect(lat, `${feature.id} lat`).toBeGreaterThanOrEqual(NYC.minLat);
      expect(lat, `${feature.id} lat`).toBeLessThanOrEqual(NYC.maxLat);
      expect(lng, `${feature.id} lng`).toBeGreaterThanOrEqual(NYC.minLng);
      expect(lng, `${feature.id} lng`).toBeLessThanOrEqual(NYC.maxLng);
    }
  });

  it('agrees with itself across geojson, metadata.json and report.json', () => {
    const collection = validateCollection(readJson(GEOJSON));
    const metadata = validateMetadata(readJson(METADATA));
    const report = readJson<Report>(REPORT);
    const features = collection.features;

    expect(metadata.recordCount).toBe(features.length);
    expect(metadata.sourceRowCount).toBe(report.sourceRows);
    expect(report.publishedLocations).toBe(features.length);
    expect(metadata.contentHash).toBe(report.contentHash);

    const byType = (type: string): number =>
      features.filter((f) => f.properties.type === type).length;
    for (const type of DINING_TYPES) {
      expect(byType(type), `type ${type}`).toBe(metadata.counts[type]);
    }
    for (const borough of BOROUGHS) {
      expect(
        features.filter((f) => f.properties.borough === borough).length,
        `borough ${borough}`,
      ).toBe(metadata.boroughs[borough]);
    }
  });

  it('carries no field the source does not have', () => {
    // The brief forbids fabricating cuisine, hours, prices, ratings, reviews, menus and
    // seating. If a future change adds one of these to the artifact, this fails.
    const collection = validateCollection(readJson(GEOJSON));
    const allowed = new Set([
      'id', 'name', 'legalName', 'street', 'neighborhood', 'borough', 'zip',
      'type', 'status', 'licenseIssued', 'licenseExpires', 'nta', 'bbl', 'sid',
    ]);
    const forbidden = ['hours', 'cuisine', 'price', 'rating', 'reviews', 'menu', 'seating', 'tables'];
    for (const feature of collection.features) {
      for (const key of Object.keys(feature.properties)) {
        expect(allowed.has(key), `unexpected property ${key}`).toBe(true);
        expect(forbidden).not.toContain(key);
      }
    }
  });

  it('derives `both` only where two source licences really exist', () => {
    // `both` is not a source value. It must correspond to a feature whose `sid` lists two
    // source rows — otherwise the merge invented something.
    const collection = validateCollection(readJson(GEOJSON));
    const both = collection.features.filter((f) => f.properties.type === 'both');
    expect(both.length).toBeGreaterThan(0);
    for (const feature of both) {
      expect(feature.properties.sid.length, feature.id).toBeGreaterThanOrEqual(2);
    }
    const singles = collection.features.filter(
      (f) => (f.properties.type === 'sidewalk' || f.properties.type === 'roadway') &&
        f.properties.sid.length > 1,
    );
    expect(singles, 'a single-type feature must not merge two licences').toHaveLength(0);
  });

  it('publishes boroughs and a non-zero population per borough', () => {
    const collection = validateCollection(readJson(GEOJSON));
    const present = new Set(collection.features.map((f) => f.properties.borough));
    // All five NYC boroughs have at least one licensed establishment in the source.
    for (const borough of BOROUGHS) {
      expect(present.has(borough), `borough ${borough} missing`).toBe(true);
    }
  });

  it('records a retrieval time and an upstream update time, not a hard-coded date', () => {
    const metadata = validateMetadata(readJson(METADATA));
    // The UI renders this string. If it were hard-coded, "Data updated" would go stale
    // silently — the exact failure the brief calls out.
    expect(metadata.retrievedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(metadata.datasetId).toBe('fpeh-f7ci');
    expect(metadata.attribution).toContain('Department of Transportation');
  });
});

describe('the production build carries the dataset', () => {
  const distData = resolve(ROOT, 'dist/data');

  it('ships both artifacts, byte-identical to the source', async () => {
    if (!existsSync(distData)) {
      // `npm test` runs before `npm run build`. CI and `npm run verify` build first.
      expect(existsSync(resolve(ROOT, 'dist/index.html'))).toBe(false);
      return;
    }
    for (const name of ['cafes.geojson', 'metadata.json']) {
      const built = await readFile(resolve(distData, name));
      const source = await readFile(resolve(ROOT, 'public/data', name));
      expect(built.equals(source), `${name} was transformed or truncated by the build`).toBe(true);
    }
    expect(existsSync(resolve(ROOT, 'dist/index.html'))).toBe(true);
  });
});
