/**
 * INTEGRATION NOTES (src/data/dataset.ts)
 *
 * Runtime validation of the published artifact against the frozen contract in
 * `src/types/location.ts`. Pure: no `fetch`, no React, no MapLibre — every input is a
 * parameter, so `tests/data-load.test.ts` drives it with inline fixtures and never needs
 * `public/data/cafes.geojson` to exist.
 *
 * Validation is deliberately strict and non-repairing. A field with the wrong type is an
 * error, not something to coerce: a blank map caused by a silently mangled payload is far
 * worse than a visible error state. The objects returned are freshly constructed, so
 * downstream code can trust the types without re-checking.
 *
 * Public surface:
 *   class DatasetError
 *   type DatasetIndex
 *   MAX_FEATURE_COUNT
 *   validateCollection(raw: unknown, label?: string): LocationCollection
 *   validateMetadata(raw: unknown, label?: string): DatasetMetadata
 *   indexCollection(collection: LocationCollection): DatasetIndex
 */

import { BOROUGHS, DINING_TYPES } from '../types/location';
import type {
  Borough,
  DatasetMetadata,
  DiningType,
  LocationCollection,
  LocationFeature,
  LocationProperties,
} from '../types/location';
import type { LatLng } from '../lib/distance';

/** A payload larger than this is not our dataset; treat it as corrupt rather than OOM. */
export const MAX_FEATURE_COUNT = 50_000;

const ID_PATTERN = /^eoy-[0-9a-f]{12}$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const BOROUGH_SET: ReadonlySet<string> = new Set<string>(BOROUGHS);
const TYPE_SET: ReadonlySet<string> = new Set<string>(DINING_TYPES);

export class DatasetError extends Error {
  override readonly name = 'DatasetError';

  constructor(message: string) {
    super(message);
  }
}

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

function asNullableString(
  label: string,
  path: string,
  value: unknown,
  { allowEmpty = true }: { allowEmpty?: boolean } = {},
): string | null {
  if (value === null || value === undefined) return null;
  return asString(label, path, value, { allowEmpty });
}

function asDateOrNull(label: string, path: string, value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = asString(label, path, value);
  if (!DATE_PATTERN.test(text)) {
    fail(label, path, 'a YYYY-MM-DD calendar date', value);
  }
  return text;
}

function asFiniteNumber(label: string, path: string, value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    fail(label, path, 'a finite number', value);
  }
  return value;
}

function validateProperties(
  label: string,
  path: string,
  raw: unknown,
): LocationProperties {
  const source = asObject(label, path, raw);

  const id = asString(label, `${path}.id`, source['id']);
  if (!ID_PATTERN.test(id)) fail(label, `${path}.id`, 'an id of the form eoy-<12 hex chars>', source['id']);

  const neighborhood = asNullableString(label, `${path}.neighborhood`, source['neighborhood']);
  const nta = asNullableString(label, `${path}.nta`, source['nta']);
  const bbl = asNullableString(label, `${path}.bbl`, source['bbl']);

  const boroughRaw = source['borough'];
  if (typeof boroughRaw !== 'string' || !BOROUGH_SET.has(boroughRaw)) {
    fail(label, `${path}.borough`, 'one of the five NYC boroughs', boroughRaw);
  }

  const typeRaw = source['type'];
  if (typeof typeRaw !== 'string' || !TYPE_SET.has(typeRaw)) {
    fail(label, `${path}.type`, 'one of sidewalk | roadway | both', typeRaw);
  }

  const sidRaw = source['sid'];
  if (!Array.isArray(sidRaw) || sidRaw.length === 0) {
    fail(label, `${path}.sid`, 'a non-empty array of Socrata row ids', sidRaw);
  }
  const sid = sidRaw.map((value, index) => asString(label, `${path}.sid[${index}]`, value));

  return {
    id,
    name: asString(label, `${path}.name`, source['name']),
    legalName: asString(label, `${path}.legalName`, source['legalName']),
    street: asString(label, `${path}.street`, source['street']),
    neighborhood,
    borough: boroughRaw as Borough,
    zip: asString(label, `${path}.zip`, source['zip']),
    type: typeRaw as DiningType,
    status: asString(label, `${path}.status`, source['status']),
    licenseIssued: asDateOrNull(label, `${path}.licenseIssued`, source['licenseIssued']),
    licenseExpires: asDateOrNull(label, `${path}.licenseExpires`, source['licenseExpires']),
    nta,
    bbl,
    sid,
  };
}

function validateFeature(label: string, index: number, raw: unknown): LocationFeature {
  const path = `features[${index}]`;
  const feature = asObject(label, path, raw);

  if (feature['type'] !== 'Feature') fail(label, `${path}.type`, 'the string "Feature"', feature['type']);

  const id = asString(label, `${path}.id`, feature['id']);
  const properties = validateProperties(label, `${path}.properties`, feature['properties']);
  if (properties.id !== id) {
    fail(label, `${path}.id`, `the same id as ${path}.properties.id (${properties.id})`, id);
  }

  const geometry = asObject(label, `${path}.geometry`, feature['geometry']);
  if (geometry['type'] !== 'Point') fail(label, `${path}.geometry.type`, 'the string "Point"', geometry['type']);

  const coordinates = geometry['coordinates'];
  if (!Array.isArray(coordinates) || coordinates.length !== 2) {
    fail(label, `${path}.geometry.coordinates`, 'a [lng, lat] pair', coordinates);
  }
  const lng = asFiniteNumber(label, `${path}.geometry.coordinates[0]`, coordinates[0]);
  const lat = asFiniteNumber(label, `${path}.geometry.coordinates[1]`, coordinates[1]);
  if (lat < -90 || lat > 90) fail(label, `${path}.geometry.coordinates[1]`, 'a latitude in [-90, 90]', lat);
  if (lng < -180 || lng > 180) fail(label, `${path}.geometry.coordinates[0]`, 'a longitude in [-180, 180]', lng);

  return { type: 'Feature', id, geometry: { type: 'Point', coordinates: [lng, lat] }, properties };
}

/**
 * Asserts the payload is a `FeatureCollection` of contract-shaped points and returns a
 * freshly built, fully typed collection. Throws `DatasetError` on the first problem.
 */
export function validateCollection(raw: unknown, label = 'cafes.geojson'): LocationCollection {
  const collection = asObject(label, 'root', raw);
  if (collection['type'] !== 'FeatureCollection') {
    fail(label, 'type', 'the string "FeatureCollection"', collection['type']);
  }

  const features = collection['features'];
  if (!Array.isArray(features)) fail(label, 'features', 'an array', features);
  if (features.length === 0) {
    throw new DatasetError(`${label}: features is empty — refusing to render a blank map`);
  }
  if (features.length > MAX_FEATURE_COUNT) {
    throw new DatasetError(
      `${label}: ${features.length} features exceeds the ${MAX_FEATURE_COUNT} sanity limit`,
    );
  }

  const seen = new Set<string>();
  const validated = features.map((feature, index) => {
    const parsed = validateFeature(label, index, feature);
    if (seen.has(parsed.id)) {
      throw new DatasetError(`${label}: duplicate location id ${parsed.id}`);
    }
    seen.add(parsed.id);
    return parsed;
  });

  return { type: 'FeatureCollection', features: validated };
}

function asIsoTimestamp(label: string, path: string, value: unknown): string {
  const text = asString(label, path, value);
  if (!Number.isFinite(Date.parse(text))) fail(label, path, 'an ISO-8601 timestamp', value);
  return text;
}

function asCount(label: string, path: string, value: unknown): number {
  const count = asFiniteNumber(label, path, value);
  if (count < 0 || !Number.isInteger(count)) fail(label, path, 'a non-negative integer', value);
  return count;
}

/** Asserts `metadata.json` against the `DatasetMetadata` contract. */
export function validateMetadata(raw: unknown, label = 'metadata.json'): DatasetMetadata {
  const meta = asObject(label, 'root', raw);

  const countsRaw = asObject(label, 'counts', meta['counts']);
  const counts = {} as Record<DiningType, number>;
  for (const type of DINING_TYPES) {
    counts[type] = asCount(label, `counts.${type}`, countsRaw[type]);
  }

  const boroughsRaw = asObject(label, 'boroughs', meta['boroughs']);
  const boroughs: Record<string, number> = {};
  for (const [name, value] of Object.entries(boroughsRaw)) {
    boroughs[name] = asCount(label, `boroughs.${name}`, value);
  }

  return {
    dataset: asString(label, 'dataset', meta['dataset']),
    datasetId: asString(label, 'datasetId', meta['datasetId']),
    provider: asString(label, 'provider', meta['provider']),
    source: asString(label, 'source', meta['source']),
    attribution: asString(label, 'attribution', meta['attribution']),
    retrievedAt: asIsoTimestamp(label, 'retrievedAt', meta['retrievedAt']),
    sourceUpdatedAt:
      meta['sourceUpdatedAt'] === null || meta['sourceUpdatedAt'] === undefined
        ? null
        : asIsoTimestamp(label, 'sourceUpdatedAt', meta['sourceUpdatedAt']),
    recordCount: asCount(label, 'recordCount', meta['recordCount']),
    sourceRowCount: asCount(label, 'sourceRowCount', meta['sourceRowCount']),
    contentHash: asString(label, 'contentHash', meta['contentHash']),
    counts,
    boroughs,
  };
}

export interface DatasetIndex {
  /** The validated FeatureCollection, handed to the MapLibre GeoJSON source as-is. */
  readonly collection: LocationCollection;
  /** Flat list, same object references as `collection.features[].properties`. */
  readonly locations: readonly LocationProperties[];
  /** O(1) lookup for the detail sheet and `focusOn`. */
  readonly byId: ReadonlyMap<string, LocationProperties>;
  /**
   * Coordinates by id. `LocationProperties` carries no position by contract, but the map
   * needs one to fly to a selection, so the index keeps the geometry reachable.
   */
  readonly coords: ReadonlyMap<string, LatLng>;
}

export function indexCollection(collection: LocationCollection): DatasetIndex {
  const byId = new Map<string, LocationProperties>();
  const coords = new Map<string, LatLng>();
  const locations: LocationProperties[] = [];

  for (const feature of collection.features) {
    byId.set(feature.properties.id, feature.properties);
    coords.set(feature.properties.id, {
      lat: feature.geometry.coordinates[1],
      lng: feature.geometry.coordinates[0],
    });
    locations.push(feature.properties);
  }

  return { collection, locations, byId, coords };
}
