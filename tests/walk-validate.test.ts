/**
 * THE VALIDATOR'S TEST SUITE. Every case is an inline payload, and every assertion names the
 * class of corruption it represents, because "throws" is only useful as a test if the message
 * says which rule fired.
 *
 * The shape of the suite follows `tests/data-load.test.ts`: one assertion per malformed field,
 * plus the cross-field rules, plus the four sanity limits. Nothing here reads
 * `public/data/walk/**`, so it is green on a clean checkout.
 */

import { describe, expect, it } from 'vitest';
import { DatasetError } from '../src/data/dataset';
import {
  MAX_HISTORICAL_SITES,
  MAX_SENSOR_COUNTERS,
  MAX_SURVEYS_PER_SITE,
  MAX_SURVEYS_TOTAL,
  checkLatestAgainstSensors,
  validateHistoricalCollection,
  validateHistoricalPatterns,
  validateLatest,
  validateSensorCollection,
} from '../src/data/walk/validate';
import { STALENESS_STATES } from '../src/types/walk';
import {
  HISTORICAL_COLLECTION,
  LATEST_RAW,
  PATTERNS_RAW,
  SENSOR_BUSY,
  SENSOR_COLLECTION,
  SENSOR_OFFLINE,
  SENSOR_STALE_ZERO_BUCKET,
} from './helpers/walkFixtures';

/**
 * A deep clone, so a mutation cannot reach the shared fixture.
 *
 * The two-step `as unknown as LooseShape` at each call site is deliberate. A validator test's
 * whole job is to hand the validator something of the right SHAPE and the wrong VALUES, and a
 * `FeatureCollection` whose properties are about to be replaced with nonsense does not
 * structurally overlap with a "some of its fields are now nonsense" type. Routing through
 * `unknown` says exactly that, in one place per test, rather than in a helper that guesses.
 */
function clone(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value)) as unknown;
}

/*
 * `exactOptionalPropertyTypes` is on in this repo, which means an optional property may NOT be
 * assigned `undefined` explicitly. These are therefore `T | undefined` rather than `?T`, which
 * is also honest: a payload being built for a validator test really may be missing any of them.
 */
interface LooseGeometry {
  type: string | undefined;
  coordinates: number[];
}

interface LooseFeature {
  id: string | undefined;
  type: string | undefined;
  geometry: LooseGeometry;
  properties: Record<string, unknown>;
}

interface LooseCollection {
  type: string;
  features: LooseFeature[];
}

function looseCollection(value: unknown): LooseCollection {
  return clone(value) as unknown as LooseCollection;
}

/** Replaces one property of the first feature, and nothing else. */
function historicalWith(path: string, value: unknown): unknown {
  const raw = looseCollection(HISTORICAL_COLLECTION);
  const first = raw.features[0];
  if (first === undefined) throw new Error('the fixture has no features to mutate');
  first.properties[path] = value;
  return raw;
}

function sensorWith(path: string, value: unknown): unknown {
  const raw = looseCollection(SENSOR_COLLECTION);
  const first = raw.features[0];
  if (first === undefined) throw new Error('the fixture has no features to mutate');
  first.properties[path] = value;
  return raw;
}

/** The collection with the feature at `index` replaced wholesale. */
function withFeature(value: unknown, index: number, replacement: LooseFeature): unknown {
  const raw = looseCollection(value);
  const existing = raw.features[index];
  if (existing === undefined) throw new Error(`the fixture has no feature at index ${index}`);
  raw.features[index] = { ...replacement, id: replacement.id ?? existing.id };
  return raw;
}

/** A loose copy of a fixture feature, for the "replace this one" cases above. */
function looseFeature(value: unknown): LooseFeature {
  return clone(value) as unknown as LooseFeature;
}

function loosePatterns(value: unknown): {
  siteCount: number;
  sites: Record<string, { discrete?: boolean; interpolate?: boolean; surveyCount: number; surveys: Record<string, unknown>[] }>;
} {
  return clone(value) as unknown as {
    siteCount: number;
    sites: Record<string, { discrete?: boolean; interpolate?: boolean; surveyCount: number; surveys: Record<string, unknown>[] }>;
  };
}

function looseLatest(value: unknown): { latestObservation: string | null; sensors: Record<string, unknown>[] } {
  return clone(value) as unknown as { latestObservation: string | null; sensors: Record<string, unknown>[] };
}

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
] as const;

/**
 * `count` strictly-increasing surveys starting at January 1990, so a long synthetic series
 * stays inside the contract's year window instead of tripping the year rule first. Months
 * cycle, which is what a real bi-annual programme does anyway.
 */
function syntheticSurveys(count: number): Record<string, unknown>[] {
  return Array.from({ length: count }, (_unused, index) => {
    const year = 1990 + Math.floor(index / 12);
    const month = (index % 12) + 1;
    return {
      year,
      month,
      label: `${MONTH_NAMES[month - 1]} ${year}`,
      am: 1,
      md: 1,
      pm: 1,
      total: 3,
      complete: true,
    };
  });
}

describe('a well-formed payload passes and is rebuilt, not passed through', () => {
  it('accepts the historical collection and returns freshly built features', () => {
    const built = validateHistoricalCollection(looseCollection(HISTORICAL_COLLECTION));
    expect(built.type).toBe('FeatureCollection');
    expect(built.features).toHaveLength(5);
    // Freshly constructed: mutating the input cannot reach the returned object.
    const input = looseCollection(HISTORICAL_COLLECTION);
    expect(built.features[0]).not.toBe(input.features[0]);
  });

  it('accepts the sensor collection', () => {
    expect(validateSensorCollection(clone(SENSOR_COLLECTION)).features).toHaveLength(4);
  });

  it('accepts an EMPTY sensor collection, because four counters is the whole programme', () => {
    // The one deliberate difference from `validateCollection`: zero automated counters is a
    // fact about the programme, not a broken artifact, and a red card claiming the network
    // failed would be the dishonest response to it.
    const built = validateSensorCollection({ type: 'FeatureCollection', features: [] });
    expect(built.features).toEqual([]);
  });
});

describe('the FeatureCollection envelope is checked before anything inside it', () => {
  it('rejects a root that is not an object', () => {
    expect(() => validateHistoricalCollection('not json')).toThrow(DatasetError);
    expect(() => validateHistoricalCollection(null)).toThrow(/must be an object/);
  });

  it('rejects a root that is not a FeatureCollection', () => {
    expect(() => validateHistoricalCollection({ type: 'Feature', features: [] })).toThrow(
      /type must be the string "FeatureCollection"/,
    );
  });

  it('rejects a `features` that is not an array', () => {
    expect(() => validateHistoricalCollection({ type: 'FeatureCollection', features: {} })).toThrow(
      /features must be an array/,
    );
  });

  it('rejects an EMPTY historical collection, because a blank survey map is a broken artifact', () => {
    expect(() => validateHistoricalCollection({ type: 'FeatureCollection', features: [] })).toThrow(
      /features is empty — refusing to render a blank survey map/,
    );
  });

  it('rejects a feature whose `type` is not "Feature"', () => {
    const raw = looseCollection(HISTORICAL_COLLECTION);
    const first = raw.features[0];
    if (first !== undefined) first.type = 'Point';
    expect(() => validateHistoricalCollection(raw)).toThrow(/features\[0\]\.type must be the string "Feature"/);
  });
});

describe('the id recipe is a validation gate, not a convention', () => {
  it('rejects a historical id that is not wsh-<12 hex>', () => {
    expect(() => validateHistoricalCollection(historicalWith('id', 'eoy-0000000000a1'))).toThrow(
      /must be an id of the form wsh-<12 hex chars>/,
    );
  });

  it('rejects a historical id that has a sensor prefix', () => {
    expect(() => validateHistoricalCollection(historicalWith('id', 'wsk-0000000000a1'))).toThrow(
      DatasetError,
    );
  });

  it('rejects an uppercase hex id', () => {
    expect(() => validateHistoricalCollection(historicalWith('id', 'wsh-0000000000A1'))).toThrow(
      DatasetError,
    );
  });

  it('rejects a sensor id that is not wsk-<12 hex>', () => {
    expect(() => validateSensorCollection(sensorWith('id', 'wsh-0000000000b1'))).toThrow(
      /must be an id of the form wsk-<12 hex chars>/,
    );
  });

  it('rejects a feature id that disagrees with its properties id', () => {
    const raw = looseCollection(HISTORICAL_COLLECTION);
    const first = raw.features[0];
    if (first !== undefined) first.id = 'wsh-00000000dead';
    expect(() => validateHistoricalCollection(raw)).toThrow(
      /must be the same id as features\[0\]\.properties\.id/,
    );
  });

  it('rejects a duplicate id rather than letting one silently win', () => {
    const raw = looseCollection(HISTORICAL_COLLECTION);
    const twin = raw.features[0];
    if (twin === undefined) throw new Error('no fixture feature');
    raw.features.push({ ...twin });
    expect(() => validateHistoricalCollection(raw)).toThrow(/duplicate site id wsh-0000000000a1/);
  });
});

describe('property types are checked, not coerced', () => {
  it('rejects a numeric `name`', () => {
    expect(() => validateHistoricalCollection(historicalWith('name', 42))).toThrow(
      /name must be a string, got the number 42/,
    );
  });

  it('rejects a blank `name`', () => {
    expect(() => validateHistoricalCollection(historicalWith('name', '   '))).toThrow(
      /name must be a non-empty string/,
    );
  });

  it('rejects a stringified `inPedestrianVolumeIndex`', () => {
    expect(() =>
      validateHistoricalCollection(historicalWith('inPedestrianVolumeIndex', 'true')),
    ).toThrow(/inPedestrianVolumeIndex must be a boolean/);
  });

  it('rejects a fractional count', () => {
    expect(() => validateHistoricalCollection(historicalWith('am', 12.5))).toThrow(
      /am must be a non-negative integer/,
    );
  });

  it('rejects a NEGATIVE am — `change` is the only signed field in the contract', () => {
    expect(() => validateHistoricalCollection(historicalWith('am', -1))).toThrow(DatasetError);
  });

  it('accepts a null am, because a period the source did not measure is a real state', () => {
    expect(validateHistoricalCollection(historicalWith('am', null)).features[0]?.properties.am).toBeNull();
  });

  it('accepts a NEGATIVE change, because 41 of the 114 published sites are falling', () => {
    expect(validateHistoricalCollection(historicalWith('change', -9800)).features[0]?.properties.change).toBe(
      -9800,
    );
  });

  it('rejects an impossible year', () => {
    expect(() => validateHistoricalCollection(historicalWith('firstYear', 1899))).toThrow(
      /firstYear must be a four-digit year between 1990 and 2100/,
    );
  });

  it('rejects an unparseable ISO timestamp on a sensor', () => {
    expect(() => validateSensorCollection(sensorWith('observedAt', 'the other day'))).toThrow(
      /observedAt must be an ISO-8601 timestamp/,
    );
  });
});

describe('the enum vocabularies come from the frozen contract, not from this validator', () => {
  it('rejects a trend that is not one of the four', () => {
    expect(() => validateHistoricalCollection(historicalWith('trend', 'exploding'))).toThrow(
      /trend must be one of rising \| falling \| flat \| insufficient/,
    );
  });

  it('rejects a staleness that is not one of the five', () => {
    expect(() => validateSensorCollection(sensorWith('staleness', 'sleepy'))).toThrow(
      /staleness must be one of fresh \| faulted \| stale \| offline \| unavailable/,
    );
  });

  it('accepts every staleness the contract publishes, `faulted` included', () => {
    // The rejection above is only meaningful if the allowed set is read from the contract
    // rather than written out here. A list that gained `faulted` on one side only would
    // reject real published data, so assert the enum check never fires for a published
    // value.
    //
    // Only the ENUM check is asserted, not validity. The shared fixture carries an
    // observation, so reading it as `fresh` legitimately trips a cross-field rule — and
    // those rules have their own cases below. A test that demanded full validity for
    // every state would be testing the fixture, not the vocabulary.
    for (const staleness of STALENESS_STATES) {
      let message = '';
      try {
        validateSensorCollection(sensorWith('staleness', staleness));
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message, `staleness ${staleness} was rejected as not in the allowed set`).not.toMatch(
        /staleness must be one of/,
      );
    }
  });

  it('rejects an activity that is not one of the five', () => {
    expect(() => validateSensorCollection(sensorWith('activity', 'packed'))).toThrow(
      /activity must be one of unavailable \| quiet \| typical \| busy \| veryBusy/,
    );
  });

  it('rejects a `quiet` written as `Quiety`', () => {
    expect(() => validateSensorCollection(sensorWith('activity', 'Quiety'))).toThrow(DatasetError);
  });
});

describe('the cross-field rules, which are the ones a shape check cannot catch', () => {
  it('rejects a total that is not the sum of am, md and pm', () => {
    // `total` is what mostSurveyed sorts on, and the definition is in the contract's own
    // comment. A total that disagrees with the three parts is arithmetic the artifact got wrong,
    // and the UI would sort on it and print it.
    expect(() => validateHistoricalCollection(historicalWith('total', 999))).toThrow(
      /total is 999 but am \+ md \+ pm is 13272/,
    );
  });

  it('rejects an offline counter that still carries an observation', () => {
    const dead = looseFeature(SENSOR_OFFLINE);
    dead.properties['observedAt'] = '2026-09-01T00:00:00Z';
    dead.properties['count'] = 3;
    expect(() => validateSensorCollection(withFeature(SENSOR_COLLECTION, 2, dead))).toThrow(
      /is offline but carries an observation/,
    );
  });

  it('rejects a level with no observation, because a missing measurement is not a measurement of nothing', () => {
    // `staleness` stays `offline` and `observedAt` stays null, so the payload is otherwise
    // coherent and the ACTIVITY rule is the one that fires.
    const dead = looseFeature(SENSOR_OFFLINE);
    dead.properties['activity'] = 'quiet';
    expect(() => validateSensorCollection(withFeature(SENSOR_COLLECTION, 2, dead))).toThrow(
      /activity is "quiet" with no observation/,
    );
  });

  it('rejects `unavailable` alongside a real observation', () => {
    const busy = looseFeature(SENSOR_BUSY);
    busy.properties['activity'] = 'unavailable';
    expect(() => validateSensorCollection(withFeature(SENSOR_COLLECTION, 1, busy))).toThrow(
      /activity is "unavailable" yet an observation is present/,
    );
  });

  it('rejects a ratio against an expectation of zero, which is 0/0 and not a measurement', () => {
    const busy = looseFeature(SENSOR_BUSY);
    busy.properties['expected'] = 0;
    busy.properties['ratio'] = 0;
    expect(() => validateSensorCollection(withFeature(SENSOR_COLLECTION, 1, busy))).toThrow(
      /ratio is 0 but features\[1\]\.properties\.expected is 0/,
    );
  });

  it('ACCEPTS count 0 with expected 0 and percentile 50, because that is the published reality', () => {
    // Both reporting counters look exactly like this: a 01:15 bucket in which nobody was
    // counted, and a median of an empty distribution. Rejecting it would blank the map over a
    // TRUE observation. The refusal belongs in the UI — see tests/walk-display.test.ts.
    const built = validateSensorCollection(clone(SENSOR_COLLECTION));
    const zeroBucket = built.features.find((feature) => feature.properties.id === SENSOR_STALE_ZERO_BUCKET.id);
    expect(zeroBucket?.properties.count).toBe(0);
    expect(zeroBucket?.properties.percentile).toBe(50);
    expect(zeroBucket?.properties.activity).toBe('quiet');
  });

  it('rejects a repeated sensor id inside one `sensorIds` list', () => {
    expect(() =>
      validateSensorCollection(sensorWith('sensorIds', ['300000001', '300000001'])),
    ).toThrow(/repeats a sensor id/);
  });

  it('rejects two features sharing one counterSerial — the phantom-twin trap', () => {
    const raw = looseCollection(SENSOR_COLLECTION);
    const twin = raw.features[1];
    if (twin === undefined) throw new Error('no fixture feature at index 1');
    const copy: LooseFeature = {
      ...twin,
      id: 'wsk-0000000000ff',
      properties: { ...twin.properties, id: 'wsk-0000000000ff', sensorIds: ['300999999'] },
    };
    raw.features.push(copy);
    expect(() => validateSensorCollection(raw)).toThrow(
      /counter serial YAH22104565 appears on two features/,
    );
  });

  it('rejects an empty `sensorIds`, which is the whole dedup key', () => {
    expect(() => validateSensorCollection(sensorWith('sensorIds', []))).toThrow(
      /sensorIds must be a non-empty array/,
    );
  });
});

describe('the geometry is checked, because a point off the planet is a blank map', () => {
  it('rejects a non-Point geometry', () => {
    const raw = looseCollection(HISTORICAL_COLLECTION);
    const first = raw.features[0];
    if (first !== undefined) first.geometry.type = 'Polygon';
    expect(() => validateHistoricalCollection(raw)).toThrow(
      /geometry\.type must be the string "Point"/,
    );
  });

  it('rejects a latitude out of range', () => {
    const raw = looseCollection(HISTORICAL_COLLECTION);
    const first = raw.features[0];
    if (first !== undefined) first.geometry.coordinates[1] = 91;
    expect(() => validateHistoricalCollection(raw)).toThrow(/must be a latitude in \[-90, 90\]/);
  });

  it('rejects a coordinates array of the wrong length', () => {
    const raw = looseCollection(HISTORICAL_COLLECTION);
    const first = raw.features[0];
    if (first !== undefined) first.geometry.coordinates = [1, 2, 3];
    expect(() => validateHistoricalCollection(raw)).toThrow(/must be a \[lng, lat\] pair/);
  });
});

describe('the survey series is checked for the two properties the chart depends on', () => {
  it('rejects `discrete: false`, which is an instruction to draw a continuous line', () => {
    const raw = loosePatterns(PATTERNS_RAW);
    const site = raw.sites['wsh-0000000000a1'];
    if (site !== undefined) site.discrete = false;
    expect(() => validateHistoricalPatterns(raw)).toThrow(
      /discrete must be true — these are separate surveys, not a continuous series/,
    );
  });

  it('rejects `interpolate: true`', () => {
    const raw = loosePatterns(PATTERNS_RAW);
    const site = raw.sites['wsh-0000000000a1'];
    if (site !== undefined) site.interpolate = true;
    expect(() => validateHistoricalPatterns(raw)).toThrow(/interpolate must be false/);
  });

  it('rejects a site key that is not a wsh- id', () => {
    const raw = loosePatterns(PATTERNS_RAW);
    const source = raw.sites['wsh-0000000000a1'];
    if (source !== undefined) raw.sites['wsk-0000000000a1'] = source;
    expect(() => validateHistoricalPatterns(raw)).toThrow(/must be a key of the form wsh-/);
  });

  it('rejects surveys that are not strictly increasing, which would draw a day that never happened', () => {
    const raw = loosePatterns(PATTERNS_RAW);
    const surveys = raw.sites['wsh-0000000000a1']?.surveys;
    if (surveys !== undefined) surveys.reverse();
    expect(() => validateHistoricalPatterns(raw)).toThrow(/not strictly increasing/);
  });

  it('rejects a repeated survey month', () => {
    const raw = loosePatterns(PATTERNS_RAW);
    const surveys = raw.sites['wsh-0000000000a1']?.surveys;
    const first = surveys?.[0];
    if (surveys !== undefined && first !== undefined) surveys[1] = { ...first };
    expect(() => validateHistoricalPatterns(raw)).toThrow(/not strictly increasing/);
  });

  it('rejects a surveyCount that disagrees with the surveys it counts', () => {
    const raw = loosePatterns(PATTERNS_RAW);
    const site = raw.sites['wsh-0000000000a1'];
    if (site !== undefined) site.surveyCount = 99;
    expect(() => validateHistoricalPatterns(raw)).toThrow(/surveyCount is 99 but surveys holds 5/);
  });

  it('rejects a siteCount that disagrees with the sites it counts', () => {
    const raw = loosePatterns(PATTERNS_RAW);
    raw.siteCount = 400;
    expect(() => validateHistoricalPatterns(raw)).toThrow(/siteCount is 400 but sites holds 2/);
  });

  it('rejects a survey total that is not the sum of its three periods', () => {
    const raw = loosePatterns(PATTERNS_RAW);
    const first = raw.sites['wsh-0000000000a1']?.surveys[0];
    if (first !== undefined) first['total'] = 9999;
    expect(() => validateHistoricalPatterns(raw)).toThrow(/total is 9999 but am \+ md \+ pm is 600/);
  });

  it('rejects a month outside 1 to 12', () => {
    const raw = loosePatterns(PATTERNS_RAW);
    const first = raw.sites['wsh-0000000000a1']?.surveys[0];
    if (first !== undefined) first['month'] = 13;
    expect(() => validateHistoricalPatterns(raw)).toThrow(/month must be a whole number from 1 to 12/);
  });

  it('rejects a site with no surveys at all', () => {
    const raw = loosePatterns(PATTERNS_RAW);
    const site = raw.sites['wsh-0000000000a1'];
    if (site !== undefined) site.surveys = [];
    expect(() => validateHistoricalPatterns(raw)).toThrow(/surveys must be a non-empty array/);
  });

  it('rejects an empty `sites` object', () => {
    const raw = loosePatterns(PATTERNS_RAW);
    raw.sites = {};
    raw.siteCount = 0;
    expect(() => validateHistoricalPatterns(raw)).toThrow(
      /sites is empty — there is nothing to chart and nothing to plot/,
    );
  });
});

describe('latest.json is checked, and checked against sensors.geojson', () => {
  it('accepts a well-formed feed', () => {
    const raw = looseLatest(LATEST_RAW);
    expect(validateLatest(raw).sensors).toHaveLength(2);
  });

  it('rejects a percentile outside 0 to 100', () => {
    const raw = looseLatest(LATEST_RAW);
    const first = raw.sensors[0];
    if (first !== undefined) first['percentile'] = 140;
    expect(() => validateLatest(raw)).toThrow(/percentile must be a position in \[0, 100\]/);
  });

  it('rejects a duplicate sensor in the feed', () => {
    const raw = looseLatest(LATEST_RAW);
    const first = raw.sensors[0];
    if (first !== undefined) raw.sensors.push({ ...first });
    expect(() => validateLatest(raw)).toThrow(/duplicate sensor id/);
  });

  it('accepts a null `latestObservation`, which is a fact about an empty feed', () => {
    expect(validateLatest({ latestObservation: null, sensors: [] }).latestObservation).toBeNull();
  });

  it('rejects a reading for a counter that is not in sensors.geojson', () => {
    // Two pipeline steps, two snapshots: an id can drift between them, and data the app holds
    // and never draws is the same class of quiet failure as a blank map.
    const latest = validateLatest(clone(LATEST_RAW));
    const sensors = validateSensorCollection(clone(SENSOR_COLLECTION));
    expect(() => checkLatestAgainstSensors(latest, sensors)).not.toThrow();

    const drifted = validateLatest({
      latestObservation: '2026-09-28T05:15:00Z',
      sensors: [
        {
          id: 'wsk-00000000dead',
          name: 'A Counter From Another Run',
          borough: 'Brooklyn',
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
    });
    expect(() => checkLatestAgainstSensors(drifted, sensors)).toThrow(
      /has a reading for wsk-00000000dead, which is not in sensors.geojson/,
    );
  });
});

describe('the sanity limits, which turn a corrupted payload into an error rather than an OOM', () => {
  function manySites(count: number): unknown {
    const template = looseCollection(HISTORICAL_COLLECTION).features[0];
    if (template === undefined) throw new Error('no fixture feature');
    return {
      type: 'FeatureCollection',
      features: Array.from({ length: count }, (_unused, index) => {
        const id = `wsh-${index.toString(16).padStart(12, '0')}`;
        return {
          ...template,
          id,
          geometry: { ...template.geometry, coordinates: [...template.geometry.coordinates] },
          properties: { ...template.properties, id },
        };
      }),
    };
  }

  it(`rejects more than ${MAX_HISTORICAL_SITES} survey sites`, () => {
    expect(() => validateHistoricalCollection(manySites(MAX_HISTORICAL_SITES + 1))).toThrow(
      new RegExp(`exceeds the ${MAX_HISTORICAL_SITES} sanity limit`),
    );
  });

  it(`accepts exactly ${MAX_HISTORICAL_SITES} survey sites`, () => {
    expect(validateHistoricalCollection(manySites(MAX_HISTORICAL_SITES)).features).toHaveLength(
      MAX_HISTORICAL_SITES,
    );
  });

  it(`rejects more than ${MAX_SENSOR_COUNTERS} counters`, () => {
    const overBudget = {
      type: 'FeatureCollection',
      features: new Array(MAX_SENSOR_COUNTERS + 1).fill(SENSOR_BUSY),
    };
    expect(() => validateSensorCollection(overBudget)).toThrow(
      new RegExp(`exceeds the ${MAX_SENSOR_COUNTERS} sanity limit`),
    );
  });

  it(`rejects more than ${MAX_SURVEYS_PER_SITE} surveys at one site`, () => {
    const raw = loosePatterns(PATTERNS_RAW);
    const site = raw.sites['wsh-0000000000a1'];
    if (site !== undefined) {
      site.surveys = syntheticSurveys(MAX_SURVEYS_PER_SITE + 1);
      site.surveyCount = site.surveys.length;
    }
    expect(() => validateHistoricalPatterns(raw)).toThrow(
      new RegExp(`over the ${MAX_SURVEYS_PER_SITE} per-site limit`),
    );
  });

  it(`rejects more than ${MAX_SURVEYS_TOTAL} surveys overall`, () => {
    const perSite = MAX_SURVEYS_PER_SITE;
    const siteCount = Math.floor(MAX_SURVEYS_TOTAL / perSite) + 2;
    const template = loosePatterns(PATTERNS_RAW).sites['wsh-0000000000a1'];
    if (template === undefined) throw new Error('no fixture site');

    const sites: Record<string, unknown> = {};
    for (let index = 0; index < siteCount; index += 1) {
      const id = `wsh-${index.toString(16).padStart(12, '0')}`;
      const surveys = syntheticSurveys(perSite);
      sites[id] = { ...template, discrete: true, interpolate: false, surveyCount: surveys.length, surveys };
    }
    const raw = clone(PATTERNS_RAW) as unknown as { sites: unknown; siteCount: number };
    raw.sites = sites;
    raw.siteCount = siteCount;

    expect(() => validateHistoricalPatterns(raw)).toThrow(
      new RegExp(`exceeds the ${MAX_SURVEYS_TOTAL} sanity limit`),
    );
  });
});

describe("the error type is the app's, so the shell renders it as a dataset error", () => {
  it('is a DatasetError and carries `name`', () => {
    try {
      validateHistoricalCollection({ type: 'FeatureCollection', features: [] });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(DatasetError);
      expect((error as Error).name).toBe('DatasetError');
    }
  });

  it('names the artifact in every message, so a failure is traceable to a file', () => {
    try {
      validateSensorCollection({ type: 'FeatureCollection', features: [{}] }, 'walk/sensors.geojson');
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as Error).message).toMatch(/^walk\/sensors\.geojson: /);
    }
  });
});
