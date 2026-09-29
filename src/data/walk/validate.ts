/**
 * INTEGRATION NOTES (src/data/walk/validate.ts)
 *
 * Runtime validation of the four published Where NYC Walks artifacts against the frozen
 * contract in `src/types/walk.ts`. Mirrors `src/data/dataset.ts` in every decision and
 * differs from it in exactly one, which is a judgement and is stated below.
 *
 * Pure: no `fetch`, no React, no MapLibre — every input is a parameter, so the tests drive
 * it with inline fixtures and never need `public/data/walk/**` to exist.
 *
 * Validation is strict and non-repairing. A wrong type is an error, not something to coerce:
 * a blank map caused by a silently mangled payload is far worse than a visible error state.
 * The objects returned are freshly constructed, so downstream code can trust the types.
 *
 * THE ONE DELIBERATE DIFFERENCE FROM `dataset.ts`: an EMPTY `cafes.geojson` is an error,
 * because 2 000 rows with none of them is a broken artifact. An EMPTY `sensors.geojson` is
 * NOT an error, because four physical counters is the whole automated program and zero is a
 * fact about it rather than a symptom — the honest response to "there are no counters" is a
 * legend that says so, not a red card claiming the network failed. `historical-locations.geojson`
 * and `historical-patterns.json` are both required to be non-empty, because a survey site
 * with no surveys and a collection of sites with no patterns are each a broken pipeline.
 *
 * WHY THIS FILE IS STRICTER THAN A SHAPE CHECK. Three of the assertions below are
 * cross-field, and each one exists because the two artifacts it compares are produced by
 * separate runs that can disagree:
 *   - `latest.json` ids must all exist in `sensors.geojson`. Two runs, two snapshots.
 *   - a sensor whose `staleness` is `offline`/`unavailable` must have no observation, and a
 *     sensor claiming a level must have one. The contract says so in prose; this makes a
 *     violation a visible error instead of a contradictory label.
 *   - a `ratio` is refused when `expected` is 0. `0/0` is not a measurement, and the
 *     pipeline already declines to publish one.
 *
 * What is DELIBERATELY NOT asserted, and why: that `count: 0` with `expected: 0` and
 * `percentile: 50` is invalid. That is exactly what today's artifact contains, for both
 * reporting counters, because the newest 15-minute bucket lands at 01:15 and the counter
 * measured nobody — which is a true reading of an empty hour, not corruption. Rejecting the
 * payload would blank the map over a real observation. The UI is where that fact is refused
 * to become an activity LEVEL, and that refusal lives in one place:
 * `displayActivity()` in `src/features/walk/display.ts`.
 *
 * Public surface:
 *   MAX_HISTORICAL_SITES, MAX_SENSOR_COUNTERS, MAX_SURVEYS_PER_SITE, MAX_SURVEYS_TOTAL
 *   validateHistoricalCollection, validateSensorCollection
 *   validateHistoricalPatterns, validateLatest, checkLatestAgainstSensors
 *   type WalkItem, type WalkIndex, type WalkSurvey, type WalkPatterns, type WalkLatest
 *   indexWalk
 */

import { DatasetError } from '../dataset';
import { SENSOR_ACTIVITIES, STALENESS_STATES, TREND_STATES } from '../../types/walk';
import type {
  HistoricalCollection,
  HistoricalFeature,
  HistoricalProperties,
  SensorActivity,
  SensorCollection,
  SensorFeature,
  SensorProperties,
  Staleness,
  Trend,
} from '../../types/walk';
import type { LatLng } from '../../lib/distance';

/*
 * The sanity limits. Not decoration: each one is the number above which the payload is "not
 * our dataset" rather than "a big dataset". `historical-locations.geojson` is 114 features
 * and `historical-patterns.json` is 4 107 surveys, so these leave roughly a 17x margin on
 * the sites and a 10x margin on the surveys while still catching a payload that has been
 * concatenated, re-projected into the wrong collection, or replaced with a city's worth of
 * something else.
 */
export const MAX_HISTORICAL_SITES = 2_000;
export const MAX_SENSOR_COUNTERS = 64;
export const MAX_SURVEYS_PER_SITE = 400;
export const MAX_SURVEYS_TOTAL = 40_000;

const HISTORICAL_ID_PATTERN = /^wsh-[0-9a-f]{12}$/;
const SENSOR_ID_PATTERN = /^wsk-[0-9a-f]{12}$/;

const TREND_SET: ReadonlySet<string> = new Set<string>(TREND_STATES);
const STALENESS_SET: ReadonlySet<string> = new Set<string>(STALENESS_STATES);
const ACTIVITY_SET: ReadonlySet<string> = new Set<string>(SENSOR_ACTIVITIES);

// ---------------------------------------------------------------------------
// Primitive readers. Same shape as src/data/dataset.ts, same messages, so a failure
// points at a path rather than at a type.
// ---------------------------------------------------------------------------

function describe(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'nothing';
  if (Array.isArray(value)) return 'an array';
  if (typeof value === 'string') return `the string ${JSON.stringify(truncate(value))}`;
  if (typeof value === 'object') return 'an object';
  return `the ${typeof value} ${String(value)}`;
}

function truncate(value: string): string {
  return value.length > 40 ? `${value.slice(0, 40)}…` : value;
}

function fail(label: string, path: string, expectation: string, actual: unknown): never {
  throw new DatasetError(`${label}: ${path} must be ${expectation}, got ${describe(actual)}`);
}

function refuse(label: string, reason: string): never {
  throw new DatasetError(`${label}: ${reason}`);
}

function asObject(label: string, path: string, value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail(label, path, 'an object', value);
  }
  return value as Record<string, unknown>;
}

function asString(
  label: string,
  path: string,
  value: unknown,
  { allowEmpty = false }: { allowEmpty?: boolean } = {},
): string {
  if (typeof value !== 'string') fail(label, path, 'a string', value);
  if (!allowEmpty && value.trim().length === 0) fail(label, path, 'a non-empty string', value);
  return value;
}

function asNullableString(label: string, path: string, value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return asString(label, path, value, { allowEmpty: true });
}

function asBoolean(label: string, path: string, value: unknown): boolean {
  if (typeof value !== 'boolean') fail(label, path, 'a boolean', value);
  return value;
}

function asFiniteNumber(label: string, path: string, value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    fail(label, path, 'a finite number', value);
  }
  return value;
}

/** A count: a whole number of people. Negative or fractional is a bug, not a measurement. */
function asCount(label: string, path: string, value: unknown): number {
  const count = asFiniteNumber(label, path, value);
  if (count < 0 || !Number.isInteger(count)) fail(label, path, 'a non-negative integer', value);
  return count;
}

function asNullableCount(label: string, path: string, value: unknown): number | null {
  if (value === null || value === undefined) return null;
  return asCount(label, path, value);
}

function asYear(label: string, path: string, value: unknown): number {
  const year = asFiniteNumber(label, path, value);
  // 1990 is a floor the DOT screenline programme clears by a decade and a ceiling of 2100
  // catches a four-digit typo without needing a calendar.
  if (!Number.isInteger(year) || year < 1990 || year > 2100) {
    fail(label, path, 'a four-digit year between 1990 and 2100', value);
  }
  return year;
}

function asNullableYear(label: string, path: string, value: unknown): number | null {
  if (value === null || value === undefined) return null;
  return asYear(label, path, value);
}

function asEnum<T extends string>(
  label: string,
  path: string,
  value: unknown,
  allowed: ReadonlySet<string>,
  expectation: string,
): T {
  if (typeof value !== 'string' || !allowed.has(value)) {
    fail(label, path, expectation, value);
  }
  return value as T;
}

function asIsoTimestamp(label: string, path: string, value: unknown): string {
  const text = asString(label, path, value);
  if (!Number.isFinite(Date.parse(text))) fail(label, path, 'an ISO-8601 timestamp', value);
  return text;
}

function asNullableIsoTimestamp(label: string, path: string, value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return asIsoTimestamp(label, path, value);
}

/** `[lng, lat]`, both in range. The order is GeoJSON's and is not ours to change. */
function asPoint(label: string, path: string, value: unknown): [number, number] {
  if (!Array.isArray(value) || value.length !== 2) {
    fail(label, path, 'a [lng, lat] pair', value);
  }
  const lng = asFiniteNumber(label, `${path}[0]`, value[0]);
  const lat = asFiniteNumber(label, `${path}[1]`, value[1]);
  if (lat < -90 || lat > 90) fail(label, `${path}[1]`, 'a latitude in [-90, 90]', lat);
  if (lng < -180 || lng > 180) fail(label, `${path}[0]`, 'a longitude in [-180, 180]', lng);
  return [lng, lat];
}

// ---------------------------------------------------------------------------
// historical-locations.geojson — the 114 manual survey sites. The primary dataset.
// ---------------------------------------------------------------------------

/**
 * `change` is a signed difference, so it is the one count in the contract that may be
 * negative — 41 of the 114 published sites are falling. Declared before `validateHistoricalProperties`
 * uses it, which is why it sits next to the other count readers rather than after them.
 */
function asSignedInteger(label: string, path: string, value: unknown): number {
  const parsed = asFiniteNumber(label, path, value);
  if (!Number.isInteger(parsed)) fail(label, path, 'a whole number', value);
  return parsed;
}

function asNullableSignedInteger(label: string, path: string, value: unknown): number | null {
  if (value === null || value === undefined) return null;
  return asSignedInteger(label, path, value);
}

function validateHistoricalProperties(
  label: string,
  path: string,
  raw: unknown,
): HistoricalProperties {
  const source = asObject(label, path, raw);

  const id = asString(label, `${path}.id`, source['id']);
  if (!HISTORICAL_ID_PATTERN.test(id)) {
    fail(label, `${path}.id`, 'an id of the form wsh-<12 hex chars>', source['id']);
  }

  const total = asNullableCount(label, `${path}.total`, source['total']);
  const am = asNullableCount(label, `${path}.am`, source['am']);
  const md = asNullableCount(label, `${path}.md`, source['md']);
  const pm = asNullableCount(label, `${path}.pm`, source['pm']);

  // `total` is defined by the contract as am + md + pm, and the whole feature rests on a
  // number whose three parts are published beside it. A total that disagrees with them is
  // arithmetic the artifact got wrong, and it would be sorted on.
  if (total !== null && am !== null && md !== null && pm !== null && total !== am + md + pm) {
    refuse(
      label,
      `${path}.total is ${total} but am + md + pm is ${am + md + pm} — the contract defines total as their sum`,
    );
  }

  return {
    id,
    name: asString(label, `${path}.name`, source['name']),
    street: asString(label, `${path}.street`, source['street']),
    crossStreet: asNullableString(label, `${path}.crossStreet`, source['crossStreet']),
    borough: asString(label, `${path}.borough`, source['borough']),
    inPedestrianVolumeIndex: asBoolean(
      label,
      `${path}.inPedestrianVolumeIndex`,
      source['inPedestrianVolumeIndex'],
    ),
    am,
    md,
    pm,
    total,
    change: asNullableSignedInteger(label, `${path}.change`, source['change']),
    changeYears: asNullableString(label, `${path}.changeYears`, source['changeYears']),
    firstYear: asNullableYear(label, `${path}.firstYear`, source['firstYear']),
    lastYear: asNullableYear(label, `${path}.lastYear`, source['lastYear']),
    yearsMeasured: asCount(label, `${path}.yearsMeasured`, source['yearsMeasured']),
    latestSurvey: asNullableString(label, `${path}.latestSurvey`, source['latestSurvey']),
    trend: asEnum<Trend>(
      label,
      `${path}.trend`,
      source['trend'],
      TREND_SET,
      `one of ${TREND_STATES.join(' | ')}`,
    ),
  };
}

function validateHistoricalFeature(label: string, index: number, raw: unknown): HistoricalFeature {
  const path = `features[${index}]`;
  const feature = asObject(label, path, raw);

  if (feature['type'] !== 'Feature') {
    fail(label, `${path}.type`, 'the string "Feature"', feature['type']);
  }

  const id = asString(label, `${path}.id`, feature['id']);
  const properties = validateHistoricalProperties(label, `${path}.properties`, feature['properties']);
  if (properties.id !== id) {
    fail(label, `${path}.id`, `the same id as ${path}.properties.id (${properties.id})`, id);
  }

  const geometry = asObject(label, `${path}.geometry`, feature['geometry']);
  if (geometry['type'] !== 'Point') {
    fail(label, `${path}.geometry.type`, 'the string "Point"', geometry['type']);
  }

  return {
    type: 'Feature',
    id,
    geometry: { type: 'Point', coordinates: asPoint(label, `${path}.geometry.coordinates`, geometry['coordinates']) },
    properties,
  };
}

/**
 * Asserts the 114 manual survey sites. Throws `DatasetError` on the first problem, including
 * an empty collection, because a survey map with no survey sites is a broken artifact rather
 * than a fact about the city.
 */
export function validateHistoricalCollection(
  raw: unknown,
  label = 'walk/historical-locations.geojson',
): HistoricalCollection {
  const collection = asObject(label, 'root', raw);
  if (collection['type'] !== 'FeatureCollection') {
    fail(label, 'type', 'the string "FeatureCollection"', collection['type']);
  }

  const features = collection['features'];
  if (!Array.isArray(features)) fail(label, 'features', 'an array', features);
  if (features.length === 0) {
    refuse(label, 'features is empty — refusing to render a blank survey map');
  }
  if (features.length > MAX_HISTORICAL_SITES) {
    refuse(label, `${features.length} features exceeds the ${MAX_HISTORICAL_SITES} sanity limit`);
  }

  const seen = new Set<string>();
  const validated = features.map((feature, index) => {
    const parsed = validateHistoricalFeature(label, index, feature);
    if (seen.has(parsed.id)) refuse(label, `duplicate site id ${parsed.id}`);
    seen.add(parsed.id);
    return parsed;
  });

  return { type: 'FeatureCollection', features: validated };
}

// ---------------------------------------------------------------------------
// sensors.geojson — the four automated counters.
// ---------------------------------------------------------------------------

function validateSensorProperties(label: string, path: string, raw: unknown): SensorProperties {
  const source = asObject(label, path, raw);

  const id = asString(label, `${path}.id`, source['id']);
  if (!SENSOR_ID_PATTERN.test(id)) {
    fail(label, `${path}.id`, 'an id of the form wsk-<12 hex chars>', source['id']);
  }

  const sensorIdsRaw = source['sensorIds'];
  if (!Array.isArray(sensorIdsRaw) || sensorIdsRaw.length === 0) {
    fail(label, `${path}.sensorIds`, 'a non-empty array of Socrata sensor ids', sensorIdsRaw);
  }
  const sensorIds = sensorIdsRaw.map((value, index) =>
    asString(label, `${path}.sensorIds[${index}]`, value),
  );
  // The counter is keyed on `counterSerial` precisely because the source publishes it under
  // two sensor ids. Duplicates inside one list would put that trap back.
  if (new Set(sensorIds).size !== sensorIds.length) {
    refuse(label, `${path}.sensorIds repeats a sensor id: ${JSON.stringify(sensorIds)}`);
  }

  const staleness = asEnum<Staleness>(
    label,
    `${path}.staleness`,
    source['staleness'],
    STALENESS_SET,
    `one of ${STALENESS_STATES.join(' | ')}`,
  );
  const activity = asEnum<SensorActivity>(
    label,
    `${path}.activity`,
    source['activity'],
    ACTIVITY_SET,
    `one of ${SENSOR_ACTIVITIES.join(' | ')}`,
  );
  const count = asNullableCount(label, `${path}.count`, source['count']);
  const expected = asNullableCount(label, `${path}.expected`, source['expected']);
  const observedAt = asNullableIsoTimestamp(label, `${path}.observedAt`, source['observedAt']);
  const firstObservation = asNullableIsoTimestamp(label, `${path}.firstObservation`, source['firstObservation']);
  const lastObservation = asNullableIsoTimestamp(label, `${path}.lastObservation`, source['lastObservation']);

  const ratioRaw = source['ratio'];
  const ratio = ratioRaw === null || ratioRaw === undefined ? null : asFiniteNumber(label, `${path}.ratio`, ratioRaw);
  // `0/0` is undefined, not zero, and the pipeline already declines to publish a ratio there.
  if (ratio !== null && expected === 0) {
    refuse(
      label,
      `${path}.ratio is ${ratio} but ${path}.expected is 0 — a ratio against an expectation of zero is not a measurement`,
    );
  }

  const percentileRaw = source['percentile'];
  const percentile =
    percentileRaw === null || percentileRaw === undefined
      ? null
      : asFiniteNumber(label, `${path}.percentile`, percentileRaw);
  if (percentile !== null && (percentile < 0 || percentile > 100)) {
    fail(label, `${path}.percentile`, 'a position in [0, 100]', percentileRaw);
  }

  // Freshness and the presence of an observation are the same fact, and a card that says
  // "Offline" above a count and a timestamp is self-contradicting in a way nobody can debug
  // from the UI.
  const hasObservation = observedAt !== null && count !== null;
  if (staleness === 'offline' && hasObservation) {
    refuse(
      label,
      `${path} is offline but carries an observation at ${observedAt} — freshness and the observation must agree`,
    );
  }
  if (staleness === 'unavailable' && hasObservation) {
    refuse(label, `${path} is unavailable but carries an observation at ${observedAt}`);
  }
  if (activity !== 'unavailable' && !hasObservation) {
    refuse(
      label,
      `${path}.activity is "${activity}" with no observation — a missing measurement is not a measurement of nothing`,
    );
  }
  if (activity === 'unavailable' && hasObservation) {
    refuse(
      label,
      `${path}.activity is "unavailable" yet an observation is present at ${observedAt} — pick one or the other`,
    );
  }
  if (lastObservation === null && hasObservation) {
    refuse(label, `${path}.lastObservation is null but ${path}.observedAt is ${observedAt}`);
  }

  return {
    id,
    name: asString(label, `${path}.name`, source['name']),
    counterSerial: asString(label, `${path}.counterSerial`, source['counterSerial']),
    sensorIds,
    borough: asString(label, `${path}.borough`, source['borough']),
    granularity: asString(label, `${path}.granularity`, source['granularity']),
    directional: asBoolean(label, `${path}.directional`, source['directional']),
    firstObservation,
    lastObservation,
    active: asBoolean(label, `${path}.active`, source['active']),
    staleness,
    activity,
    count,
    expected,
    percentile,
    ratio,
    observationCount: asCount(label, `${path}.observationCount`, source['observationCount']),
    observedAt,
  };
}

function validateSensorFeature(label: string, index: number, raw: unknown): SensorFeature {
  const path = `features[${index}]`;
  const feature = asObject(label, path, raw);

  if (feature['type'] !== 'Feature') {
    fail(label, `${path}.type`, 'the string "Feature"', feature['type']);
  }

  const id = asString(label, `${path}.id`, feature['id']);
  const properties = validateSensorProperties(label, `${path}.properties`, feature['properties']);
  if (properties.id !== id) {
    fail(label, `${path}.id`, `the same id as ${path}.properties.id (${properties.id})`, id);
  }

  const geometry = asObject(label, `${path}.geometry`, feature['geometry']);
  if (geometry['type'] !== 'Point') {
    fail(label, `${path}.geometry.type`, 'the string "Point"', geometry['type']);
  }

  return {
    type: 'Feature',
    id,
    geometry: { type: 'Point', coordinates: asPoint(label, `${path}.geometry.coordinates`, geometry['coordinates']) },
    properties,
  };
}

/**
 * Asserts the automated counters. An EMPTY collection is accepted on purpose — see the module
 * header — and the limit is what guards against a payload that is not this dataset.
 */
export function validateSensorCollection(
  raw: unknown,
  label = 'walk/sensors.geojson',
): SensorCollection {
  const collection = asObject(label, 'root', raw);
  if (collection['type'] !== 'FeatureCollection') {
    fail(label, 'type', 'the string "FeatureCollection"', collection['type']);
  }

  const features = collection['features'];
  if (!Array.isArray(features)) fail(label, 'features', 'an array', features);
  if (features.length > MAX_SENSOR_COUNTERS) {
    refuse(label, `${features.length} features exceeds the ${MAX_SENSOR_COUNTERS} sanity limit`);
  }

  const seen = new Set<string>();
  const serials = new Set<string>();
  const validated = features.map((feature, index) => {
    const parsed = validateSensorFeature(label, index, feature);
    if (seen.has(parsed.id)) refuse(label, `duplicate sensor id ${parsed.id}`);
    // Two ids for one physical counter is exactly the phantom-twin failure the contract's
    // `counterSerial` keying exists to prevent, so it is caught at the door.
    if (serials.has(parsed.properties.counterSerial)) {
      refuse(
        label,
        `counter serial ${parsed.properties.counterSerial} appears on two features — key the collection on counterSerial`,
      );
    }
    seen.add(parsed.id);
    serials.add(parsed.properties.counterSerial);
    return parsed;
  });

  return { type: 'FeatureCollection', features: validated };
}

// ---------------------------------------------------------------------------
// historical-patterns.json — the per-site survey series. Discrete, never interpolated.
// ---------------------------------------------------------------------------

/** ONE manual screenline survey, as published. The `total` is that day's am + md + pm. */
export interface WalkSurvey {
  readonly year: number;
  readonly month: number;
  /** "May 2026", the label the source itself publishes. */
  readonly label: string;
  readonly am: number | null;
  readonly md: number | null;
  readonly pm: number | null;
  readonly total: number;
  /** False when at least one of the three periods was not measured. */
  readonly complete: boolean;
}

export interface WalkSiteSeries {
  readonly id: string;
  readonly street: string;
  readonly crossStreet: string | null;
  readonly borough: string;
  readonly surveyCount: number;
  readonly surveys: readonly WalkSurvey[];
}

export interface WalkPatterns {
  /** Provenance, taken from the artifact rather than from the clock. */
  readonly dataset: string;
  readonly datasetId: string;
  readonly source: string;
  readonly attribution: string;
  /** ISO-8601 UTC. When this artifact was generated. */
  readonly generatedAt: string;
  /** The source's own statement of what a row is. */
  readonly measurement: string;
  readonly interpolation: string;
  readonly note: string;
  readonly siteCount: number;
  readonly sites: ReadonlyMap<string, WalkSiteSeries>;
}

function validateSurvey(label: string, path: string, raw: unknown): WalkSurvey {
  const source = asObject(label, path, raw);

  const year = asYear(label, `${path}.year`, source['year']);
  const month = asFiniteNumber(label, `${path}.month`, source['month']);
  if (!Number.isInteger(month) || month < 1 || month > 12) {
    fail(label, `${path}.month`, 'a whole number from 1 to 12', source['month']);
  }

  const am = asNullableCount(label, `${path}.am`, source['am']);
  const md = asNullableCount(label, `${path}.md`, source['md']);
  const pm = asNullableCount(label, `${path}.pm`, source['pm']);
  const total = asCount(label, `${path}.total`, source['total']);

  if (am !== null && md !== null && pm !== null && total !== am + md + pm) {
    refuse(
      label,
      `${path}.total is ${total} but am + md + pm is ${am + md + pm}`,
    );
  }

  return {
    year,
    month: month as number,
    label: asString(label, `${path}.label`, source['label']),
    am,
    md,
    pm,
    total,
    complete: asBoolean(label, `${path}.complete`, source['complete']),
  };
}

function validateSite(label: string, id: string, raw: unknown): WalkSiteSeries {
  const path = `sites[${id}]`;
  const source = asObject(label, path, raw);

  // The single most important assertion in this file for the chart. `interpolate: true` in
  // this artifact would be an instruction to draw a continuous line between two screenline
  // surveys the source never took, so it is refused at the door rather than obeyed.
  const discrete = source['discrete'];
  if (discrete !== true) {
    refuse(
      label,
      `${path}.discrete must be true — these are separate surveys, not a continuous series`,
    );
  }
  if (source['interpolate'] !== false) {
    refuse(label, `${path}.interpolate must be false — nothing between two surveys was measured`);
  }

  const surveysRaw = source['surveys'];
  if (!Array.isArray(surveysRaw) || surveysRaw.length === 0) {
    fail(label, `${path}.surveys`, 'a non-empty array of surveys', surveysRaw);
  }
  if (surveysRaw.length > MAX_SURVEYS_PER_SITE) {
    refuse(
      label,
      `${path}.surveys holds ${surveysRaw.length}, over the ${MAX_SURVEYS_PER_SITE} per-site limit`,
    );
  }

  const surveys = surveysRaw.map((survey, index) => validateSurvey(label, `${path}.surveys[${index}]`, survey));

  // Strictly increasing in (year, month). A chart that lays these out in file order is
  // claiming the order the source published is chronological, and a duplicated or
  // out-of-order row would silently draw a survey that never happened.
  for (let index = 1; index < surveys.length; index += 1) {
    const previous = surveys[index - 1];
    const current = surveys[index];
    if (previous === undefined || current === undefined) continue;
    const before = previous.year * 12 + previous.month;
    const after = current.year * 12 + current.month;
    if (after <= before) {
      refuse(
        label,
        `${path}.surveys is not strictly increasing: ${previous.label} (${before}) is followed by ${current.label} (${after})`,
      );
    }
  }

  const surveyCount = asCount(label, `${path}.surveyCount`, source['surveyCount']);
  if (surveyCount !== surveys.length) {
    refuse(label, `${path}.surveyCount is ${surveyCount} but surveys holds ${surveys.length}`);
  }

  return {
    id,
    street: asString(label, `${path}.street`, source['street']),
    crossStreet: asNullableString(label, `${path}.crossStreet`, source['crossStreet']),
    borough: asString(label, `${path}.borough`, source['borough']),
    surveyCount,
    surveys,
  };
}

/** Asserts the per-site survey series. */
export function validateHistoricalPatterns(
  raw: unknown,
  label = 'walk/historical-patterns.json',
): WalkPatterns {
  const root = asObject(label, 'root', raw);

  const sitesRaw = asObject(label, 'sites', root['sites']);
  const siteIds = Object.keys(sitesRaw);
  if (siteIds.length === 0) {
    refuse(label, 'sites is empty — there is nothing to chart and nothing to plot');
  }

  const sites = new Map<string, WalkSiteSeries>();
  let surveyTotal = 0;
  for (const id of siteIds) {
    if (!HISTORICAL_ID_PATTERN.test(id)) {
      fail(label, `sites[${id}]`, 'a key of the form wsh-<12 hex chars>', id);
    }
    const site = validateSite(label, id, sitesRaw[id]);
    surveyTotal += site.surveys.length;
    sites.set(id, site);
  }
  if (surveyTotal > MAX_SURVEYS_TOTAL) {
    refuse(label, `${surveyTotal} surveys exceeds the ${MAX_SURVEYS_TOTAL} sanity limit`);
  }

  const siteCount = asCount(label, 'siteCount', root['siteCount']);
  if (siteCount !== sites.size) {
    refuse(label, `siteCount is ${siteCount} but sites holds ${sites.size}`);
  }

  return {
    dataset: asString(label, 'dataset', root['dataset']),
    datasetId: asString(label, 'datasetId', root['datasetId']),
    source: asString(label, 'source', root['source']),
    attribution: asString(label, 'attribution', root['attribution']),
    generatedAt: asIsoTimestamp(label, 'generatedAt', root['generatedAt']),
    measurement: asString(label, 'measurement', root['measurement']),
    interpolation: asString(label, 'interpolation', root['interpolation']),
    note: asString(label, 'note', root['note'], { allowEmpty: true }),
    siteCount,
    sites,
  };
}

// ---------------------------------------------------------------------------
// latest.json — the automated feed's newest reading per counter.
// ---------------------------------------------------------------------------

/** One counter's newest reading, as `latest.json` publishes it. */
export interface WalkLatestSensor {
  readonly id: string;
  readonly name: string;
  readonly borough: string;
  readonly active: boolean;
  readonly staleness: Staleness;
  readonly activity: SensorActivity;
  readonly count: number | null;
  readonly expected: number | null;
  readonly percentile: number | null;
  readonly ratio: number | null;
  readonly observationCount: number;
  readonly observedAt: string | null;
}

export interface WalkLatest {
  /** ISO-8601 UTC of the newest pedestrian observation behind the file, or null. */
  readonly latestObservation: string | null;
  readonly sensors: readonly WalkLatestSensor[];
}

function validateLatestSensor(label: string, path: string, raw: unknown): WalkLatestSensor {
  const source = asObject(label, path, raw);

  const id = asString(label, `${path}.id`, source['id']);
  if (!SENSOR_ID_PATTERN.test(id)) {
    fail(label, `${path}.id`, 'an id of the form wsk-<12 hex chars>', source['id']);
  }

  const count = asNullableCount(label, `${path}.count`, source['count']);
  const expected = asNullableCount(label, `${path}.expected`, source['expected']);
  const observedAt = asNullableIsoTimestamp(label, `${path}.observedAt`, source['observedAt']);
  const activity = asEnum<SensorActivity>(
    label,
    `${path}.activity`,
    source['activity'],
    ACTIVITY_SET,
    `one of ${SENSOR_ACTIVITIES.join(' | ')}`,
  );
  const hasObservation = observedAt !== null && count !== null;
  if (activity !== 'unavailable' && !hasObservation) {
    refuse(label, `${path}.activity is "${activity}" with no observation`);
  }
  if (activity === 'unavailable' && hasObservation) {
    refuse(label, `${path}.activity is "unavailable" yet an observation is present`);
  }

  const percentileRaw = source['percentile'];
  const percentile =
    percentileRaw === null || percentileRaw === undefined
      ? null
      : asFiniteNumber(label, `${path}.percentile`, percentileRaw);
  if (percentile !== null && (percentile < 0 || percentile > 100)) {
    fail(label, `${path}.percentile`, 'a position in [0, 100]', percentileRaw);
  }

  const ratioRaw = source['ratio'];
  const ratio =
    ratioRaw === null || ratioRaw === undefined
      ? null
      : asFiniteNumber(label, `${path}.ratio`, ratioRaw);
  if (ratio !== null && expected === 0) {
    refuse(label, `${path}.ratio is ${ratio} but expected is 0`);
  }

  return {
    id,
    name: asString(label, `${path}.name`, source['name']),
    borough: asString(label, `${path}.borough`, source['borough']),
    active: asBoolean(label, `${path}.active`, source['active']),
    staleness: asEnum<Staleness>(
      label,
      `${path}.staleness`,
      source['staleness'],
      STALENESS_SET,
      `one of ${STALENESS_STATES.join(' | ')}`,
    ),
    activity,
    count,
    expected,
    percentile,
    ratio,
    observationCount: asCount(label, `${path}.observationCount`, source['observationCount']),
    observedAt,
  };
}

/** Asserts `latest.json`. The field count is checked against the sanity limit, not a floor. */
export function validateLatest(raw: unknown, label = 'walk/latest.json'): WalkLatest {
  const root = asObject(label, 'root', raw);

  const sensorsRaw = root['sensors'];
  if (!Array.isArray(sensorsRaw)) fail(label, 'sensors', 'an array', sensorsRaw);
  if (sensorsRaw.length > MAX_SENSOR_COUNTERS) {
    refuse(label, `${sensorsRaw.length} sensors exceeds the ${MAX_SENSOR_COUNTERS} sanity limit`);
  }

  const sensors = sensorsRaw.map((sensor, index) =>
    validateLatestSensor(label, `sensors[${index}]`, sensor),
  );

  const seen = new Set<string>();
  for (const sensor of sensors) {
    if (seen.has(sensor.id)) refuse(label, `duplicate sensor id ${sensor.id}`);
    seen.add(sensor.id);
  }

  return {
    latestObservation: asNullableIsoTimestamp(label, 'latestObservation', root['latestObservation']),
    sensors,
  };
}

/**
 * `latest.json` and `sensors.geojson` come from two separate pipeline steps, so an id can
 * drift between them. A latest reading for a counter that is not in the map is data the app
 * would hold and never draw, which is the same class of quiet failure as a blank map: it is
 * refused, with the id in the message so the pipeline can be named.
 */
export function checkLatestAgainstSensors(
  latest: WalkLatest,
  sensors: SensorCollection,
  label = 'walk/latest.json vs walk/sensors.geojson',
): void {
  const known = new Set(sensors.features.map((feature) => feature.properties.id));
  for (const sensor of latest.sensors) {
    if (!known.has(sensor.id)) {
      refuse(label, `latest.json has a reading for ${sensor.id}, which is not in sensors.geojson`);
    }
  }
}

// ---------------------------------------------------------------------------
// The index. One map by id over BOTH datasets, because the shell selects a single id and
// the feature has to answer for either without asking which dataset it came from.
// ---------------------------------------------------------------------------

/** Where a selection landed. The only union in the feature, and the reason for one. */
export type WalkItem =
  | { readonly kind: 'historical'; readonly properties: HistoricalProperties; readonly coords: LatLng }
  | { readonly kind: 'sensor'; readonly properties: SensorProperties; readonly coords: LatLng };

export interface WalkIndex {
  /** Handed to the MapLibre GeoJSON sources as-is. */
  readonly historical: HistoricalCollection;
  readonly sensors: SensorCollection;
  readonly patterns: WalkPatterns;
  readonly latest: WalkLatest;
  /** Historical sites first, then the counters. Stable order, so a list is stable. */
  readonly items: readonly WalkItem[];
  readonly byId: ReadonlyMap<string, WalkItem>;
  readonly coords: ReadonlyMap<string, LatLng>;
  /** The newest automated reading of all, or null when there is none. */
  readonly latestObservation: string | null;
}

function toLatLng(coordinates: readonly [number, number]): LatLng {
  return { lat: coordinates[1], lng: coordinates[0] };
}

export function indexWalk(
  historical: HistoricalCollection,
  sensors: SensorCollection,
  patterns: WalkPatterns,
  latest: WalkLatest,
): WalkIndex {
  const items: WalkItem[] = [];
  const byId = new Map<string, WalkItem>();
  const coords = new Map<string, LatLng>();

  for (const feature of historical.features) {
    const item: WalkItem = {
      kind: 'historical',
      properties: feature.properties,
      coords: toLatLng(feature.geometry.coordinates),
    };
    items.push(item);
    byId.set(feature.properties.id, item);
    coords.set(feature.properties.id, item.coords);
  }
  for (const feature of sensors.features) {
    const item: WalkItem = {
      kind: 'sensor',
      properties: feature.properties,
      coords: toLatLng(feature.geometry.coordinates),
    };
    items.push(item);
    byId.set(feature.properties.id, item);
    coords.set(feature.properties.id, item.coords);
  }

  return {
    historical,
    sensors,
    patterns,
    latest,
    items,
    byId,
    coords,
    latestObservation: latest.latestObservation,
  };
}
