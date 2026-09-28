/**
 * INLINE WALK FIXTURES.
 *
 * The same rule as `tests/helpers/fixtures.ts` and for the same reason: the four artifacts
 * under `public/data/walk/**` are produced by a separate pipeline and may not exist, so no
 * test here may read them. Every payload in this file is inline.
 *
 * WHAT THE FIXTURE SET IS BUILT TO REACH
 * --------------------------------------
 * The interesting states in this feature are all unusual, so the fixture deliberately makes
 * them the EASY case rather than the corner case:
 *
 *   - `SENSOR_STALE_ZERO_BUCKET` is the published reality for both reporting counters: a
 *     count of 0, an expectation of 0, a percentile of 50, and an `activity` of "quiet". It is
 *     the case the whole `display.ts` module exists for, so it is a first-class fixture rather
 *     than something a test builds inline.
 *   - `SENSOR_OFFLINE` and `SENSOR_NO_HISTORY` are the two offline counters, with no
 *     observation at all.
 *   - `SENSOR_BUSY` is a counter that genuinely has a reading and a real expectation, so
 *     "a level IS shown when there is one" is reachable and a test cannot pass by refusing to
 *     show a level in every case.
 *   - `SURVEY_RISING` and `SURVEY_FALLING` have opposite `change` values, and `SURVEY_FALLING`
 *     the larger magnitude of the two — which is what makes "mostChanged sorts by absolute
 *     value" a testable claim rather than a comment.
 *   - `SURVEY_UNSURVEYED` has nulls everywhere the contract allows them, so a formatter that
 *     turns a null into a zero is caught.
 *   - `SURVEY_INSUFFICIENT` exists so the `insufficient` trend is reachable at all; the
 *     published artifact has none, and a code path that has never run is not a code path.
 *
 * The coordinates are chosen so `nearby` has a real ordering, nearest first from `ORIGIN`
 * (Midtown): `SURVEY_TIE_TOTAL` (Bronx, ~9 mi), `SURVEY_RISING` (Queens, ~5 mi — wait, see
 * the note on `SURVEY_TIE_TOTAL`), then `SENSOR_STALE_ZERO_BUCKET` (Bronx), `SENSOR_BUSY`
 * (Upper Manhattan), `SURVEY_FALLING` (far Bronx), `SENSOR_OFFLINE` (Upper Manhattan) and
 * `SURVEY_UNSURVEYED` (Staten Island, last by a wide margin).
 */

import type {
  HistoricalCollection,
  HistoricalFeature,
  HistoricalProperties,
  SensorCollection,
  SensorFeature,
  SensorProperties,
} from '../../src/types/walk';
import type { LatLng } from '../../src/lib/distance';

/** A fixed instant, never `Date.now()`. 2026-09-28T15:30:00Z, mid-afternoon. */
export const NOW_ISO = '2026-09-28T15:30:00Z';
export const NOW_MS = Date.parse(NOW_ISO);

/** 14 hours before NOW, which is the age of the newest reading in the published artifact. */
export const FOURTEEN_HOURS_AGO_ISO = '2026-09-28T01:30:00Z';

export const ORIGIN: LatLng = { lat: 40.758, lng: -73.9855 };

/** A property override plus the coordinate, which is NOT a contract field — it is geometry. */
interface HistoricalSpec extends Partial<HistoricalProperties> {
  readonly id: string;
  readonly coords: LatLng;
}

function historical(overrides: HistoricalSpec): HistoricalFeature {
  const properties: HistoricalProperties = {
    name: 'A Street at B Avenue',
    street: 'A Street',
    crossStreet: 'B Avenue',
    borough: 'Manhattan',
    inPedestrianVolumeIndex: false,
    am: 2191,
    md: 4244,
    pm: 6837,
    total: 13272,
    change: 3666,
    changeYears: 'May 2007 – May 2026',
    firstYear: 2007,
    lastYear: 2026,
    yearsMeasured: 20,
    latestSurvey: 'May 2026',
    trend: 'rising',
    ...overrides,
  };
  const coords = overrides.coords;
  const { coords: _coords, ...propertyOverrides } = overrides;
  void _coords;
  return {
    type: 'Feature',
    id: overrides.id,
    geometry: { type: 'Point', coordinates: [coords.lng, coords.lat] },
    properties: { ...properties, ...propertyOverrides },
  };
}

export const SURVEY_RISING: HistoricalFeature = historical({
  id: 'wsh-0000000000a1',
  name: '82 Street at 37th Avenue',
  street: '82 Street',
  crossStreet: '37th Avenue',
  borough: 'Queens',
  inPedestrianVolumeIndex: true,
  change: 3666,
  trend: 'rising',
  coords: { lat: 40.746, lng: -73.889 },
});

/** A LARGER fall than SURVEY_RISING's rise in absolute terms, so "absolute" is testable. */
export const SURVEY_FALLING: HistoricalFeature = historical({
  id: 'wsh-0000000000a2',
  name: 'Broadway at W 231st St',
  street: 'Broadway',
  crossStreet: 'W 231st St',
  borough: 'Bronx',
  am: 1200,
  md: 2100,
  pm: 3000,
  total: 6300,
  change: -9800,
  changeYears: 'September 2007 – September 2025',
  firstYear: 2007,
  lastYear: 2025,
  yearsMeasured: 19,
  latestSurvey: 'September 2025',
  trend: 'falling',
  coords: { lat: 40.876, lng: -73.927 },
});

/** The same `total` as SURVEY_FALLING, with a SHORTER record, so the tie-break is reachable. */
export const SURVEY_TIE_TOTAL: HistoricalFeature = historical({
  id: 'wsh-0000000000a3',
  name: 'Third Avenue at 40th Street',
  street: 'Third Avenue',
  crossStreet: '40th Street',
  borough: 'Manhattan',
  am: 2000,
  md: 2000,
  pm: 2300,
  total: 6300,
  change: 0,
  changeYears: 'September 2010 – September 2025',
  firstYear: 2010,
  lastYear: 2025,
  yearsMeasured: 8,
  latestSurvey: 'September 2025',
  trend: 'flat',
  // The Bronx, so it is farther from ORIGIN than SURVEY_RISING and the `nearby` order has a
  // real ranking rather than two points a few hundred metres apart.
  coords: { lat: 40.88, lng: -73.93 },
});

export const SURVEY_UNSURVEYED: HistoricalFeature = historical({
  id: 'wsh-0000000000a4',
  name: 'A Street at an Unbuilt Crossing',
  street: 'A Street',
  crossStreet: null,
  borough: 'Staten Island',
  inPedestrianVolumeIndex: false,
  am: null,
  md: null,
  pm: null,
  total: null,
  change: null,
  changeYears: null,
  firstYear: null,
  lastYear: null,
  yearsMeasured: 0,
  latestSurvey: null,
  trend: 'insufficient',
  coords: { lat: 40.63, lng: -74.15 },
});

export const SURVEY_INSUFFICIENT: HistoricalFeature = historical({
  id: 'wsh-0000000000a5',
  name: 'A Short Record Street',
  street: 'A Short Record Street',
  crossStreet: 'Second Street',
  borough: 'Brooklyn',
  am: 40,
  md: 50,
  pm: 60,
  total: 150,
  change: 20,
  changeYears: 'May 2024 – May 2026',
  firstYear: 2024,
  lastYear: 2026,
  yearsMeasured: 2,
  latestSurvey: 'May 2026',
  trend: 'insufficient',
  coords: { lat: 40.68, lng: -73.98 },
});

export const HISTORICAL_FEATURES: readonly HistoricalFeature[] = [
  SURVEY_RISING,
  SURVEY_FALLING,
  SURVEY_TIE_TOTAL,
  SURVEY_UNSURVEYED,
  SURVEY_INSUFFICIENT,
];

export const HISTORICAL_COLLECTION: HistoricalCollection = {
  type: 'FeatureCollection',
  features: [...HISTORICAL_FEATURES],
};

interface SensorSpec extends Partial<SensorProperties> {
  readonly id: string;
  readonly coords: LatLng;
}

function sensor(overrides: SensorSpec): SensorFeature {
  const properties: SensorProperties = {
    name: 'A Counter',
    counterSerial: 'YAH00000001',
    sensorIds: ['300000001', '300000002'],
    borough: 'Bronx',
    granularity: 'PT15M',
    directional: true,
    firstObservation: '2022-01-01T00:00:00Z',
    lastObservation: FOURTEEN_HOURS_AGO_ISO,
    active: false,
    staleness: 'stale',
    activity: 'quiet',
    count: 0,
    expected: 0,
    percentile: 50,
    ratio: null,
    observationCount: 7,
    observedAt: FOURTEEN_HOURS_AGO_ISO,
    ...overrides,
  };
  const coords = overrides.coords;
  return {
    type: 'Feature',
    id: overrides.id,
    geometry: { type: 'Point', coordinates: [coords.lng, coords.lat] },
    properties,
  };
}

/**
 * THE PUBLISHED REALITY. `ct66-47at`'s newest pedestrian row is 01:15, the counter measured
 * nobody, the same slot is usually nobody, and the pipeline still says "quiet" with a
 * percentile of 50. This is the fixture the whole `display.ts` argument is about.
 */
export const SENSOR_STALE_ZERO_BUCKET: SensorFeature = sensor({
  id: 'wsk-0000000000b1',
  name: 'Concrete Plant Park',
  counterSerial: 'YAH22104563',
  sensorIds: ['300040736', '300043073'],
  staleness: 'stale',
  activity: 'quiet',
  count: 0,
  expected: 0,
  percentile: 50,
  ratio: null,
  coords: { lat: 40.827, lng: -73.885 },
});

/** A counter that HAS a reading and a real expectation, so a level is legitimately shown. */
export const SENSOR_BUSY: SensorFeature = sensor({
  id: 'wsk-0000000000b2',
  name: 'Willis Ave',
  counterSerial: 'YAH22104565',
  sensorIds: ['300028963', '300029648'],
  borough: 'Manhattan',
  staleness: 'fresh',
  activity: 'busy',
  count: 41,
  expected: 12,
  percentile: 93,
  ratio: 3.42,
  observationCount: 210,
  lastObservation: NOW_ISO,
  observedAt: NOW_ISO,
  active: true,
  coords: { lat: 40.807, lng: -73.924 },
});

/** Offline since 7 June 2026: no observation, no count, no activity. */
export const SENSOR_OFFLINE: SensorFeature = sensor({
  id: 'wsk-0000000000b3',
  name: 'High Bridge',
  counterSerial: 'YAH22104566',
  sensorIds: ['300038506', '300043077'],
  borough: 'Manhattan',
  staleness: 'offline',
  activity: 'unavailable',
  count: null,
  expected: null,
  percentile: null,
  ratio: null,
  observationCount: 0,
  lastObservation: '2026-06-07T05:45:00Z',
  observedAt: null,
  coords: { lat: 40.842, lng: -73.932 },
});

/** A counter that has NEVER reported: no `lastObservation` either. */
export const SENSOR_NO_HISTORY: SensorFeature = sensor({
  id: 'wsk-0000000000b4',
  name: 'A Counter That Never Reported',
  counterSerial: 'YAH22104599',
  sensorIds: ['300099999'],
  borough: 'Queens',
  staleness: 'unavailable',
  activity: 'unavailable',
  count: null,
  expected: null,
  percentile: null,
  ratio: null,
  observationCount: 0,
  firstObservation: null,
  lastObservation: null,
  observedAt: null,
  coords: { lat: 40.73, lng: -73.79 },
});

export const SENSOR_FEATURES: readonly SensorFeature[] = [
  SENSOR_STALE_ZERO_BUCKET,
  SENSOR_BUSY,
  SENSOR_OFFLINE,
  SENSOR_NO_HISTORY,
];

export const SENSOR_COLLECTION: SensorCollection = {
  type: 'FeatureCollection',
  features: [...SENSOR_FEATURES],
};

/** A survey series for `SURVEY_RISING`, with one INCOMPLETE survey in the middle. */
export const PATTERNS_RAW = {
  dataset: 'Bi-Annual Pedestrian Counts',
  datasetId: 'cqsj-cfgu',
  attribution: 'NYC Department of Transportation (DOT)',
  source: 'https://data.cityofnewyork.us/Transportation/Bi-Annual-Pedestrian-Counts/cqsj-cfgu',
  provider: 'New York City Department of Transportation',
  retrievedAt: '2026-09-28T19:30:29Z',
  sourceUpdatedAt: '2026-07-21T20:58:46Z',
  generatedAt: '2026-09-28T19:56:42Z',
  contentHash: 'ff'.repeat(32),
  measurement: 'discrete screenline survey',
  interpolation: 'none',
  note: 'Each entry is one manual screenline survey.',
  periodLabels: { am: 'Morning', md: 'Midday', pm: 'Evening' },
  // Only sites WITH surveys are published here. A screenline that has never been counted is
  // in `historical-locations.geojson` and absent from this file, which is why
  // `surveySeries` returns undefined for it rather than an empty chart.
  siteCount: 2,
  sites: {
    'wsh-0000000000a1': {
      street: '82 Street',
      crossStreet: '37th Avenue',
      borough: 'Queens',
      discrete: true,
      interpolate: false,
      surveyCount: 5,
      surveys: [
        { year: 2007, month: 5, label: 'May 2007', am: 100, md: 200, pm: 300, total: 600, complete: true },
        { year: 2010, month: 5, label: 'May 2010', am: 200, md: 400, pm: 600, total: 1200, complete: true },
        // Midday was not measured on this survey day. Its total is the sum of the two
        // periods that were, so plotting it would read as a quieter day.
        { year: 2015, month: 5, label: 'May 2015', am: 300, md: null, pm: 500, total: 800, complete: false },
        { year: 2020, month: 5, label: 'May 2020', am: 400, md: 700, pm: 900, total: 2000, complete: true },
        { year: 2026, month: 5, label: 'May 2026', am: 2191, md: 4244, pm: 6837, total: 13272, complete: true },
      ],
    },
    'wsh-0000000000a2': {
      street: 'Broadway',
      crossStreet: 'W 231st St',
      borough: 'Bronx',
      discrete: true,
      interpolate: false,
      surveyCount: 2,
      surveys: [
        { year: 2007, month: 9, label: 'September 2007', am: 9000, md: 9000, pm: 10000, total: 28000, complete: true },
        { year: 2025, month: 9, label: 'September 2025', am: 1200, md: 2100, pm: 3000, total: 6300, complete: true },
      ],
    },
  },
};

export const LATEST_RAW = {
  latestObservation: '2026-09-28T05:15:00Z',
  contentHash: '76'.repeat(32),
  sensors: [
    {
      id: 'wsk-0000000000b1',
      name: 'Concrete Plant Park',
      borough: 'Bronx',
      active: false,
      staleness: 'stale',
      activity: 'quiet',
      count: 0,
      expected: 0,
      percentile: 50,
      ratio: null,
      observationCount: 7,
      observedAt: FOURTEEN_HOURS_AGO_ISO,
    },
    {
      id: 'wsk-0000000000b3',
      name: 'High Bridge',
      borough: 'Manhattan',
      active: false,
      staleness: 'offline',
      activity: 'unavailable',
      count: null,
      expected: null,
      percentile: null,
      ratio: null,
      observationCount: 0,
      observedAt: null,
    },
  ],
};

/** The payloads keyed by artifact path, for the loader. */
export const WALK_PAYLOADS: Readonly<Record<string, unknown>> = {
  'data/walk/historical-locations.geojson': HISTORICAL_COLLECTION,
  'data/walk/sensors.geojson': SENSOR_COLLECTION,
  'data/walk/historical-patterns.json': PATTERNS_RAW,
  'data/walk/latest.json': LATEST_RAW,
};
