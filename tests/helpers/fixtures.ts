/**
 * Inline fixtures only. `public/data/cafes.geojson` is produced by a separate pipeline and
 * may not exist, so no test here may read the real artifact.
 *
 * The shape of the fixture is chosen so the interesting states are reachable without a
 * 2 000-row dataset:
 *
 *   - Five places, one per borough, with all three dining types represented.
 *   - Coordinates split across a Midtown box and outside it, so "in this area" is a real
 *     filter rather than a no-op.
 *   - `roadway` + `Staten Island` yields ZERO, which is what makes the "this option would
 *     show you nothing" branch of the filter panel reachable.
 */

import type {
  Borough,
  DatasetMetadata,
  DiningType,
  LocationCollection,
  LocationFeature,
  LocationProperties,
} from '../../src/types/location';
import type { LatLng } from '../../src/lib/distance';

/** Roughly Midtown. The fake controller starts the map here. */
export const MIDTOWN_BOUNDS = { west: -74.02, south: 40.7, east: -73.94, north: 40.79 };

export interface FixtureSpec {
  readonly id: string;
  readonly name: string;
  readonly street: string;
  readonly neighborhood: string | null;
  readonly borough: Borough;
  readonly zip: string;
  readonly type: DiningType;
  readonly coords: LatLng;
  readonly licenseIssued?: string | null;
  readonly licenseExpires?: string | null;
}

export function makeProperties(spec: FixtureSpec): LocationProperties {
  return {
    id: spec.id,
    name: spec.name,
    legalName: `${spec.name} LLC`,
    street: spec.street,
    neighborhood: spec.neighborhood,
    borough: spec.borough,
    zip: spec.zip,
    type: spec.type,
    status: 'Issued',
    licenseIssued: spec.licenseIssued === undefined ? '2026-06-12' : spec.licenseIssued,
    licenseExpires: spec.licenseExpires === undefined ? '2030-06-12' : spec.licenseExpires,
    nta: 'MN0502',
    bbl: '3019770033',
    sid: [`row-${spec.id}`],
  };
}

export function makeFeature(spec: FixtureSpec): LocationFeature {
  return {
    type: 'Feature',
    id: spec.id,
    geometry: { type: 'Point', coordinates: [spec.coords.lng, spec.coords.lat] },
    properties: makeProperties(spec),
  };
}

export function makeCollection(specs: readonly FixtureSpec[]): LocationCollection {
  return { type: 'FeatureCollection', features: specs.map(makeFeature) };
}

/**
 * Two inside the Midtown bounds, three well outside. Everything that depends on "in this
 * area" in the tests is derived from this split, so it is stated once here.
 */
export const FIXTURES: readonly FixtureSpec[] = [
  {
    id: 'eoy-0000000000a1',
    name: 'KATZ S DELICATESSEN',
    street: '205 EAST HOUSTON STREET',
    neighborhood: 'NEW YORK',
    borough: 'Manhattan',
    zip: '10009',
    type: 'roadway',
    coords: { lat: 40.7223, lng: -73.9875 },
  },
  {
    id: 'eoy-0000000000a2',
    name: 'LA COLOMBE',
    street: '31 WEST 27TH STREET',
    neighborhood: 'NEW YORK',
    borough: 'Manhattan',
    zip: '10001',
    type: 'both',
    coords: { lat: 40.7447, lng: -73.9924 },
  },
  {
    id: 'eoy-0000000000b1',
    name: 'EMMY',
    street: '919 FULTON STREET',
    neighborhood: null,
    borough: 'Brooklyn',
    zip: '11238',
    type: 'sidewalk',
    coords: { lat: 40.6834, lng: -73.9664 },
  },
  {
    id: 'eoy-0000000000b2',
    name: 'SUNSET PARK DINER',
    street: '8001 4TH AVENUE',
    neighborhood: 'BROOKLYN',
    borough: 'Brooklyn',
    zip: '11232',
    type: 'roadway',
    coords: { lat: 40.6455, lng: -74.0113 },
  },
  {
    id: 'eoy-0000000000c1',
    name: 'TAVERN ON THE GREEN',
    street: 'CENTRAL PARK',
    neighborhood: 'NEW YORK',
    borough: 'Manhattan',
    zip: '10027',
    type: 'sidewalk',
    coords: { lat: 40.7803, lng: -73.9688 },
  },
  {
    id: 'eoy-0000000000d1',
    name: 'FLUSHING PALACE',
    street: '136-14 37TH AVENUE',
    neighborhood: 'FLUSHING',
    borough: 'Queens',
    zip: '11354',
    type: 'both',
    coords: { lat: 40.7604, lng: -73.8246 },
  },
  {
    id: 'eoy-0000000000e1',
    name: 'BRONX COFFEE',
    street: '3200 WHITE PLAINS ROAD',
    neighborhood: 'BRONX',
    borough: 'Bronx',
    zip: '10461',
    type: 'sidewalk',
    coords: { lat: 40.844, lng: -73.927 },
  },
  {
    id: 'eoy-0000000000f1',
    name: 'STATEN ISLAND GRILL',
    street: '1300 HYLAND BOULEVARD',
    neighborhood: 'STATEN ISLAND',
    borough: 'Staten Island',
    zip: '10314',
    // Sidewalk only, so `roadway` + `Staten Island` is genuinely empty — the case that makes
    // the "this option would show you nothing" branch of the panel reachable.
    type: 'sidewalk',
    coords: { lat: 40.6401, lng: -74.1732 },
  },
];

/** `roadway` + `Staten Island` is deliberately absent from the fixture set. */
export const EMPTY_COMBINATION = { type: 'roadway' as const, borough: 'Staten Island' as const };

/** Ids inside `MIDTOWN_BOUNDS`. */
export const INSIDE_IDS: readonly string[] = [
  'eoy-0000000000a1',
  'eoy-0000000000a2',
  'eoy-0000000000c1',
];

export const METADATA_FIXTURE: DatasetMetadata = {
  dataset: 'Dining Out NYC Locations',
  datasetId: 'fpeh-f7ci',
  provider: 'Department of Transportation (DOT)',
  source: 'https://data.cityofnewyork.us/resource/fpeh-f7ci.json',
  attribution: 'NYC Open Data',
  // A fixed instant, never `Date.now()`: a test that asserts a formatted date must not
  // start failing in a different month.
  retrievedAt: '2026-09-27T10:15:00.000Z',
  sourceUpdatedAt: '2026-09-27T06:15:00.000Z',
  recordCount: FIXTURES.length,
  sourceRowCount: FIXTURES.length + 1,
  contentHash: 'a'.repeat(64),
  counts: { sidewalk: 4, roadway: 2, both: 2 },
  boroughs: {
    Manhattan: 3,
    Brooklyn: 2,
    Queens: 1,
    Bronx: 1,
    'Staten Island': 1,
  },
};
