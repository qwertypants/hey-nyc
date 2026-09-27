/**
 * FROZEN CONTRACT — shared by the data pipeline (scripts/clean_data.py) and the app.
 * Do not change a field name or its type without updating BOTH sides.
 *
 * Derived from live inspection of NYC Open Data dataset fpeh-f7ci
 * ("Dining Out NYC Locations", NYC DOT). See docs/data-dictionary.md.
 */

/** Outdoor dining license type. `both` is DERIVED, never present in the source. */
export type DiningType = 'sidewalk' | 'roadway' | 'both';

export const DINING_TYPES: readonly DiningType[] = ['sidewalk', 'roadway', 'both'] as const;

export const BOROUGHS = [
  'Manhattan',
  'Brooklyn',
  'Queens',
  'Bronx',
  'Staten Island',
] as const;

export type Borough = (typeof BOROUGHS)[number];

/**
 * One establishment, as published in public/data/cafes.geojson.
 *
 * The source publishes one ROW PER LICENSE. An establishment holding both a
 * sidewalk and a roadway licence appears as two rows at identical coordinates;
 * the pipeline merges them into a single feature with `type: 'both'`.
 */
export interface LocationProperties {
  /** `eoy-` + 12 hex chars. sha1 of `${legalName}|${street}`, stable across refreshes. */
  id: string;
  /** Display name. `assumed_name_s`, falling back to `business_legal_name`. */
  name: string;
  /** `business_legal_name` — the registered name, shown as secondary text. */
  legalName: string;
  /** `street` — house number + street only. */
  street: string;
  /** `city` — the source's neighbourhood field, UPPERCASE (e.g. "FOREST HILLS"). */
  neighborhood: string | null;
  borough: Borough;
  /** `postcode`, 5 digits, leading zero preserved (e.g. "10027"). */
  zip: string;
  type: DiningType;
  /** `license_status`. "Issued" for 100% of rows as of 2026-09-27. */
  status: string;
  /** `license_issue_date` as YYYY-MM-DD, or null. */
  licenseIssued: string | null;
  /** `license_expiration_date` as YYYY-MM-DD, or null. */
  licenseExpires: string | null;
  /** `nta2020` neighbourhood tabulation area code, e.g. "MN0502". */
  nta: string | null;
  /** `bbl` borough-block-lot, or null when the geocoder produced a degenerate value. */
  bbl: string | null;
  /** Socrata `:id` values of the source row(s) this feature was built from. Sorted. */
  sid: string[];
}

export interface LocationFeature {
  type: 'Feature';
  id: string;
  geometry: { type: 'Point'; coordinates: [number, number] };
  properties: LocationProperties;
}

export interface LocationCollection {
  type: 'FeatureCollection';
  features: LocationFeature[];
}

/** public/data/metadata.json */
export interface DatasetMetadata {
  dataset: string;
  datasetId: string;
  provider: string;
  source: string;
  attribution: string;
  /** ISO-8601 UTC — when this artifact was generated. */
  retrievedAt: string;
  /** ISO-8601 UTC — dataset `rowsUpdatedAt` from the NYC Open Data API. */
  sourceUpdatedAt: string | null;
  /** Number of published establishments. */
  recordCount: number;
  /** Number of raw source rows the pipeline read. */
  sourceRowCount: number;
  /** sha256 over canonicalised cleaned records. Drives no-op commit detection. */
  contentHash: string;
  counts: Record<DiningType, number>;
  boroughs: Record<string, number>;
}

/** public/data/report.json — data/processed/report.json is the same content. */
export interface DataReport {
  sourceRows: number;
  publishedLocations: number;
  rejected: {
    outOfBounds: number;
    unknownBorough: number;
    unparseableCoordinates: number;
    missingCoordinates: number;
  };
  mergedSidewalkAndRoadway: number;
  duplicatesRemoved: number;
  sidewalk: number;
  roadway: number;
  both: number;
  contentHash: string;
  generatedAt: string;
  /** Human-readable reasons for each rejected establishment. */
  rejections: Array<{
    name: string;
    street: string;
    city: string | null;
    borough: string | null;
    latitude: number | null;
    longitude: number | null;
    reason: string;
  }>;
}
