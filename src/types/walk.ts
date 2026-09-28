/**
 * FROZEN CONTRACT — shared by the Where NYC Walks pipeline (scripts/walk/) and the app.
 * Do not change a field name, a field type, or the set of allowed values without
 * updating BOTH sides in the same pull request.
 *
 * Two SEPARATE measurement programs live here and must never be summed:
 *
 *   SENSORS / "sensors.geojson"     automated 15-minute counters, LIVE, 4 counters
 *                                   citywide (2 still reporting) as of 2026-09.
 *   HISTORICAL / "historical-locations.geojson"
 *                                   DOT's manual bi-annual screenline counts,
 *                                   114 locations, 2007-2026. THIS is the
 *                                   dataset with real coverage.
 *
 * A "busy" label from one is not comparable to a "busy" label from the other.
 * See docs/where-nyc-walks.md.
 *
 * Why a contract rather than a convenience: docs/adr/0001-freeze-the-location-schema.md
 */

/** Relative activity versus a sensor's OWN history. Never versus the whole city. */
export const ACTIVITY_LEVELS = ['quiet', 'typical', 'busy', 'veryBusy'] as const;
export type ActivityLevel = (typeof ACTIVITY_LEVELS)[number];

/**
 * `unavailable` is a state, not a level of activity.
 *
 * It means we could not classify: no recent reading, or too little history to
 * support a comparison. The UI must show "no recent reading", NEVER "quiet" —
 * a missing measurement is not a measurement of nothing.
 */
export const SENSOR_ACTIVITIES = ['unavailable', ...ACTIVITY_LEVELS] as const;
export type SensorActivity = (typeof SENSOR_ACTIVITIES)[number];
export type SensorLevel = (typeof ACTIVITY_LEVELS)[number];

/** Freshness, derived from the age of the newest observation. */
export const STALENESS_STATES = ['fresh', 'stale', 'offline', 'unavailable'] as const;
export type Staleness = (typeof STALENESS_STATES)[number];

/** Long-term direction of a manual count site, first survey to most recent. */
export const TREND_STATES = ['rising', 'falling', 'flat', 'insufficient'] as const;
export type Trend = (typeof TREND_STATES)[number];

/** The three survey periods the historical program uses. */
export const HISTORY_PERIODS = ['am', 'md', 'pm'] as const;
export type HistoryPeriod = (typeof HISTORY_PERIODS)[number];

export const PERIOD_LABELS: Readonly<Record<HistoryPeriod, string>> = {
  am: 'Morning',
  md: 'Midday',
  pm: 'Evening',
};

/**
 * ONE PHYSICAL COUNTER, as published in public/data/walk/sensors.geojson.
 *
 * KEYED ON `counterSerial`, NOT on a Socrata `sensor_id`. The source publishes
 * each physical pedestrian counter under TWO `sensor_id` values — one row tagged
 * `bike, pedestrian`, one tagged `pedestrian` — carrying byte-identical count
 * series at identical coordinates. Keying on `sensor_id` renders four phantom
 * twins and doubles the city's measured pedestrian volume on any aggregate.
 * `sensorIds` keeps the source ids for traceability; the aggregate uses one.
 */
export interface SensorProperties {
  /** `wsk-` + 12 hex chars. sha1 of the physical `counters_serial`. */
  id: string;
  /** Display name, preferring the shortest source name for the counter. */
  name: string;
  /** The physical counter's `counters_serial` — the dedup key. */
  counterSerial: string;
  /** Every Socrata `sensor_id` that published this counter, sorted. */
  sensorIds: string[];
  borough: string;
  /** Source observation interval, e.g. "PT15M". */
  granularity: string;
  /** Whether the source splits this counter into in/out flows. */
  directional: boolean;
  /** ISO-8601 UTC. Oldest pedestrian observation for this counter. */
  firstObservation: string | null;
  /** ISO-8601 UTC. Newest pedestrian observation for this counter. */
  lastObservation: string | null;
  /** Within FRESH_WITHIN at generation time. */
  active: boolean;
  staleness: Staleness;
  activity: SensorActivity;
  /** Latest summed in+out count for the 15-minute bucket, or null if none. */
  count: number | null;
  /** Historical median for this weekday + time bucket, or null if unavailable. */
  expected: number | null;
  /** 0-100 position of `count` within this sensor's own history. */
  percentile: number | null;
  /** count / expected, or null. */
  ratio: number | null;
  /** Observations behind the baseline. Below MIN_SAMPLES means unavailable. */
  observationCount: number;
  /** ISO-8601 UTC timestamp of the observation `count` came from. */
  observedAt: string | null;
}

export interface SensorFeature {
  type: 'Feature';
  id: string;
  geometry: { type: 'Point'; coordinates: [number, number] };
  properties: SensorProperties;
}

export interface SensorCollection {
  type: 'FeatureCollection';
  features: SensorFeature[];
}

/**
 * ONE MANUAL COUNT SITE, as published in public/data/walk/historical-locations.geojson.
 *
 * The `am`/`md`/`pm` values are the MOST RECENT survey, and `total` is their
 * sum — they describe one screenline survey, not a live measurement. This is
 * the field that most needs a date next to it in the UI, because "busiest in
 * the city" and "busy in May 2026" are different claims.
 */
export interface HistoricalProperties {
  /** `wsh-` + 12 hex chars. sha1 of `loc|street|crossStreet`. */
  id: string;
  /** Display name, e.g. "Broadway at W 231st St". */
  name: string;
  /** `street_nam`. */
  street: string;
  /** `from_stree`/`to_street`, whichever is populated, else null. */
  crossStreet: string | null;
  borough: string;
  /** `iex` — in the Pedestrian Volume Index used for the Mayor's Management Report. */
  inPedestrianVolumeIndex: boolean;
  /** Morning count at the latest survey, or null if not surveyed. */
  am: number | null;
  /** Midday count at the latest survey, or null. */
  md: number | null;
  /** Evening count at the latest survey, or null. */
  pm: number | null;
  /** am + md + pm at the latest survey, or null if none of the three exist. */
  total: number | null;
  /** Signed change in `total` between the first and most recent survey. */
  change: number | null;
  /** Human-readable span of the comparison, e.g. "May 2007 – May 2026". */
  changeYears: string | null;
  firstYear: number | null;
  lastYear: number | null;
  /** How many distinct survey years have at least one count. */
  yearsMeasured: number;
  /** e.g. "May 2026". Null when the site has never been surveyed. */
  latestSurvey: string | null;
  trend: Trend;
}

export interface HistoricalFeature {
  type: 'Feature';
  id: string;
  geometry: { type: 'Point'; coordinates: [number, number] };
  properties: HistoricalProperties;
}

export interface HistoricalCollection {
  type: 'FeatureCollection';
  features: HistoricalFeature[];
}

/** public/data/walk/metadata.json */
export interface WalkMetadata {
  source: string;
  attribution: string;
  datasets: Array<{ id: string; name: string; source: string }>;
  /** ISO-8601 UTC — when these artifacts were generated. */
  generatedAt: string;
  /**
   * ISO-8601 UTC — the newest pedestrian observation behind `latest.json`.
   *
   * "Updated X ago" must be computed from THIS, not from `generatedAt`: a
   * pipeline that ran at 03:00 over data whose last reading was 14:00
   * yesterday is a day stale no matter how fresh the build is.
   */
  latestObservation: string | null;
  /** Physical counters published (4 as of 2026-09, NOT 8 — see docs). */
  sensorCount: number;
  /** Counters within the freshness threshold. */
  activePedestrianCounters: number;
  historicalLocationCount: number;
  /** Manual count sites that have ever been surveyed. */
  historicalLocationsMeasured: number;
  baselineWindow: string;
  methodologyVersion: string;
  counts: {
    sensorActivity: Record<SensorActivity, number>;
    staleness: Record<Staleness, number>;
    historicalTrend: Record<Trend, number>;
  };
  contentHash: string;
}
