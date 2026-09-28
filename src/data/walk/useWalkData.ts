/**
 * INTEGRATION NOTES (src/data/walk/useWalkData.ts)
 *
 * THE DATA HOOK for Where NYC Walks. It is the second of the two React files this feature
 * owns, and the first is this one — `load.ts` deliberately imports no React so the loader
 * stays unit-testable in jsdom.
 *
 * It returns the registry's own `FeatureData<WalkItem>`, so the shell can hold it in a
 * `useState`, hand it to `createWalkFeature`, and get back a `MapFeature` with no adapter in
 * between. That is the shape the seam implies: `MapFeature` has no `data` parameter and
 * `mount(map)` takes only the map, so the data has to arrive by construction.
 *
 *   const walk = useWalkData();
 *   const feature = useMemo(() => createWalkFeature(walk), [walk]);
 *
 * While loading or after an error, `items` is a shared empty array and `byId` is a shared
 * empty map, so a `useMemo` downstream does not churn on every render. Same guarantee, and
 * the same reason, as `useDataset`.
 *
 * PUBLIC SURFACE
 * --------------
 *   useWalkData(options?): WalkData
 *   walkProvenance(loaded, now): string | null
 *
 * `enabled` IS HOW THE LOAD IS LAZY, and it exists here rather than in the catalog because
 * React forbids calling a hook conditionally: the catalog calls this for every feature on
 * every render, and laziness has to be a property of the REQUEST rather than of the render
 * tree. `tests/feature-switching.test.tsx` asserts that switching to walk four times makes
 * exactly one request per artifact, and that nothing is requested before the first switch.
 *
 * It returns BOTH halves, because the feature needs both and the shell should have to hold
 * only one value:
 *
 *   const { data, source } = useWalkData({ enabled });
 *   const feature = useMemo(() => createWalkFeature(data, source), [data, source]);
 *
 * `data` is the registry's `FeatureData<WalkItem>` — the map, the list and the error state.
 * `source` is the survey series and the `latest.json` rows, which no `FeatureData` can carry
 * and which are behind a lookup rather than in a list. See `src/data/walk/source.ts`.
 *
 * While loading or after an error, `data.items` is a shared empty array and `data.byId` a
 * shared empty map, so a `useMemo` downstream does not churn on every render — the same
 * guarantee, and for the same reason, as `useDataset`.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { FeatureData } from '../../features/registry';
import { loadWalkOnce, resetWalkCache } from './load';
import type { LoadedWalk } from './load';
import { relativeAge } from './relativeTime';
import { walkFeatureSource } from './source';
import type { WalkFeatureSource } from './source';
import type { WalkItem } from './validate';

export interface WalkData {
  readonly data: FeatureData<WalkItem>;
  readonly source: WalkFeatureSource;
}

const NO_ITEMS: readonly WalkItem[] = [];
const NO_BY_ID: ReadonlyMap<string, WalkItem> = new Map();

interface Snapshot {
  readonly loaded: LoadedWalk | null;
  readonly error: Error | null;
  readonly generation: number;
}

export interface UseWalkDataOptions {
  /**
   * False until the visitor has actually asked for this feature. Nothing is requested while
   * it is false, which is what keeps `?mode=eat` from downloading four artifacts nobody
   * looks at.
   */
  readonly enabled?: boolean;
  /** The clock, injectable so a test can assert a relative age without waiting for it. */
  readonly now?: () => number;
}

const INITIAL: Snapshot = { loaded: null, error: null, generation: 0 };

interface NewestSurvey {
  readonly year: number;
  readonly label: string;
  readonly yearsMeasured: number;
}

/**
 * The provenance line. Deliberately about the two programs rather than about the build: a
 * "generated 4 hours ago" line on a 19-year survey dataset is the wrong fact, and
 * `src/types/walk.ts` says so — freshness is computed from `latestObservation`, never from
 * the pipeline's own run time.
 *
 * Returns null when there is no data, so the UI can omit the line rather than print a
 * placeholder.
 */
export function walkProvenance(loaded: LoadedWalk | null, now: number): string | null {
  if (loaded === null) return null;

  const sites = loaded.historical.features.length;
  const counters = loaded.sensors.features.length;

  /*
   * The newest survey, resolved by YEAR and not by comparing the labels.
   *
   * "September 2025" > "May 2026" as a string, so a lexicographic maximum reports the wrong
   * year for a dataset whose most recent survey is in the spring — which is exactly the
   * published dataset's shape (114 sites, two or three surveys a year, so the newest one is
   * whichever month happened to be last). `lastYear` is the contract's own integer for this,
   * and ties on it are broken by record length and then by id so the line is deterministic.
   */
  const newest = loaded.historical.features.reduce<NewestSurvey | null>((best, feature) => {
    const { lastYear, latestSurvey, yearsMeasured } = feature.properties;
    if (lastYear === null || latestSurvey === null) return best;
    if (best === null || lastYear > best.year) return { year: lastYear, label: latestSurvey, yearsMeasured };
    if (lastYear < best.year) return best;
    // Same year, different month (two or three surveys a year, so this is the common case for
    // a tie). The record length is the only ordering signal the site carries, so it is used,
    // and the result is deterministic either way.
    return yearsMeasured > best.yearsMeasured
      ? { year: lastYear, label: latestSurvey, yearsMeasured }
      : best;
  }, null);

  const surveyClause =
    newest === null ? `${sites} survey sites` : `${sites} survey sites, newest ${newest.label}`;

  if (counters === 0) return `${surveyClause} · no automated counters published`;
  if (loaded.latestFeed === null || loaded.latestObservation === null) {
    return `${surveyClause} · automated counters not reporting`;
  }
  return `${surveyClause} · newest automated reading ${relativeAge(loaded.latestObservation, now)}`;
}

export function useWalkData(options: UseWalkDataOptions = {}): WalkData {
  const enabled = options.enabled ?? true;
  const now = options.now ?? Date.now;
  const [snapshot, setSnapshot] = useState<Snapshot>(INITIAL);
  const [generation, setGeneration] = useState(0);

  useEffect(() => {
    if (!enabled) return;
    // No AbortController: the load is a module-level shared promise that outlives this
    // component, so aborting it would cancel a request a later mount is still waiting on.
    // Under StrictMode that turned the dev server into a permanent error card. The `active`
    // flag is the correct way to stop caring about a result nobody is waiting for.
    let active = true;

    loadWalkOnce().then(
      (loaded) => {
        if (active) setSnapshot({ loaded, error: null, generation });
      },
      (error: unknown) => {
        if (!active) return;
        setSnapshot({
          loaded: null,
          error: error instanceof Error ? error : new Error(String(error)),
          generation,
        });
      },
    );

    return () => {
      active = false;
    };
  }, [enabled, generation]);

  const retry = useCallback(() => {
    resetWalkCache();
    setSnapshot(INITIAL);
    setGeneration((value) => value + 1);
  }, []);

  const loaded = snapshot.loaded;
  const source = useMemo<WalkFeatureSource>(() => walkFeatureSource(loaded), [loaded]);

  const data = useMemo<FeatureData<WalkItem>>(() => {
    if (loaded === null) {
      return {
        status: snapshot.error === null ? 'loading' : 'error',
        items: NO_ITEMS,
        byId: NO_BY_ID,
        error: snapshot.error,
        retry,
        provenance: null,
      };
    }
    return {
      status: 'ready',
      items: loaded.items,
      byId: loaded.byId,
      error: null,
      retry,
      provenance: walkProvenance(loaded, now()),
    };
  }, [loaded, snapshot.error, retry, now]);

  return useMemo<WalkData>(() => ({ data, source }), [data, source]);
}
