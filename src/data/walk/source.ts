/**
 * INTEGRATION NOTES (src/data/walk/source.ts)
 *
 * The bundle the feature is built from, and the EMPTY one it is built from before the
 * artifacts arrive.
 *
 * WHY IT IS NOT PART OF `FeatureData`
 * ----------------------------------
 * `FeatureData<TItem>` in `src/features/registry.ts` is the shell's contract and it carries
 * `items`, `byId`, `status`, `error`, `retry` and `provenance` — everything needed to draw
 * the map and the list. What it cannot carry is the survey SERIES (`historical-patterns.json`
 * is 448 KB and belongs behind a lookup, not in a flat list) or the `latest.json` rows, which
 * a sheet reads by sensor id.
 *
 * So this is a second, small object alongside it rather than a change to the registry. The
 * shell holds both, in the order below, and neither is optional in the type:
 *
 *   const { data, source } = useWalkData();
 *   const feature = useMemo(() => createWalkFeature(data, source), [data, source]);
 *
 * THE EMPTY SOURCE IS A REAL VALUE, NOT NULL. It is what `mount` is given on the first
 * frame, before any request has answered, and it lets every method of the feature answer
 * sensibly on an empty map rather than throwing: no layers, no rows, `detail` null for every
 * id, and a legend that says the dataset is still loading. A feature that only worked once
 * its data had loaded would have to be conditionally mounted, and the shell's map container
 * deliberately exists from the first frame.
 *
 * Public surface:
 *   WalkFeatureSource, EMPTY_WALK_INDEX, walkFeatureSource
 */

import type { WalkIndex, WalkLatestSensor, WalkPatterns } from './validate';
import type { LoadedWalk } from './load';
import { indexWalk } from './validate';
import type { HistoricalCollection, SensorCollection } from '../../types/walk';

export interface WalkFeatureSource {
  /** Never null. Empty before the artifacts arrive. */
  readonly index: WalkIndex;
  /** Null before the artifacts arrive, and when `historical-patterns.json` failed to load. */
  readonly patterns: WalkPatterns | null;
  readonly latestById: ReadonlyMap<string, WalkLatestSensor>;
  /** True when `latest.json` could not be loaded. The legend says so rather than hiding it. */
  readonly latestUnavailable: boolean;
  /** The artifact's own source URL, for the legend's `aboutHref`. */
  readonly sourceUrl: string | null;
}

const EMPTY_HISTORICAL: HistoricalCollection = { type: 'FeatureCollection', features: [] };
const EMPTY_SENSORS: SensorCollection = { type: 'FeatureCollection', features: [] };

const EMPTY_PATTERNS: WalkPatterns = {
  dataset: 'Bi-Annual Pedestrian Counts',
  datasetId: 'cqsj-cfgu',
  source: '',
  attribution: 'NYC Department of Transportation (DOT)',
  generatedAt: '1970-01-01T00:00:00Z',
  measurement: 'discrete screenline survey',
  interpolation: 'none',
  note: '',
  siteCount: 0,
  sites: new Map(),
};

export const EMPTY_WALK_INDEX: WalkIndex = indexWalk(
  EMPTY_HISTORICAL,
  EMPTY_SENSORS,
  EMPTY_PATTERNS,
  { latestObservation: null, sensors: [] },
);

export function walkFeatureSource(loaded: LoadedWalk | null): WalkFeatureSource {
  if (loaded === null) {
    return {
      index: EMPTY_WALK_INDEX,
      patterns: null,
      latestById: new Map(),
      latestUnavailable: false,
      sourceUrl: null,
    };
  }
  const latestById = new Map<string, WalkLatestSensor>();
  for (const sensor of loaded.latestFeed?.sensors ?? []) {
    latestById.set(sensor.id, sensor);
  }
  return {
    index: loaded,
    patterns: loaded.patterns,
    latestById,
    latestUnavailable: loaded.latestUnavailable,
    sourceUrl: loaded.patterns.source === '' ? null : loaded.patterns.source,
  };
}
