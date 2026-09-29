/**
 * INTEGRATION NOTES (src/data/useDataset.ts)
 *
 * THE data hook Stream C consumes. Call it once, high in the tree, and pass what you get
 * down (or render a context). It never refetches on remount — the underlying promise is
 * module-level — and it aborts its own in-flight request on unmount.
 *
 *   const { status, locations, byId, coords, metadata, error, reload } = useDataset();
 *
 *   status   'loading' | 'ready' | 'error'  — drive a spinner / a real error state
 *   locations readonly LocationProperties[] — stable reference, feed the list directly
 *   byId     ReadonlyMap<string, LocationProperties> — O(1) for the detail sheet
 *   coords   ReadonlyMap<string, LatLng>     — O(1) for `focusOn(id)`
 *   metadata DatasetMetadata | null         — render `formatUpdatedAt(metadata)`
 *   error    Error | null                   — `error.message` is safe to show
 *   reload   () => void                     — clears the cache and refetches
 *
 * While loading or after an error, `locations` is a shared empty array and `byId`/`coords`
 * are shared empty maps, so `useMemo` dependencies downstream stay stable.
 *
 * This is the ONLY file in `src/data` that imports React. `load.ts` and `dataset.ts`
 * deliberately do not, which is what keeps them unit-testable in jsdom.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { DatasetMetadata, LocationProperties } from '../types/location';
import type { LatLng } from '../lib/distance';
import { loadLocationsOnce, resetDatasetCache } from './load';
import type { LoadedDataset } from './load';

export type DatasetStatus = 'loading' | 'ready' | 'error';

export interface DatasetState {
  readonly status: DatasetStatus;
  readonly locations: readonly LocationProperties[];
  readonly byId: ReadonlyMap<string, LocationProperties>;
  readonly coords: ReadonlyMap<string, LatLng>;
  readonly metadata: DatasetMetadata | null;
  readonly error: Error | null;
  readonly reload: () => void;
}

const NO_LOCATIONS: readonly LocationProperties[] = [];
const NO_BY_ID: ReadonlyMap<string, LocationProperties> = new Map();
const NO_COORDS: ReadonlyMap<string, LatLng> = new Map();

interface Snapshot {
  readonly dataset: LoadedDataset | null;
  readonly error: Error | null;
  readonly generation: number;
}

const INITIAL: Snapshot = { dataset: null, error: null, generation: 0 };

export function useDataset(): DatasetState {
  const [snapshot, setSnapshot] = useState<Snapshot>(INITIAL);
  const [generation, setGeneration] = useState(0);

  // No AbortController, deliberately. The load is a module-level shared promise, so it
  // outlives this component; aborting it would cancel a request a later mount — or another
  // consumer — is still waiting on. Under StrictMode, which remounts every effect in
  // development, that turned the dev server into a permanent error card. The `active` flag
  // is the correct way to stop caring about a result you no longer need, and it is what
  // the original `active` guard was already doing alongside the abort.
  useEffect(() => {
    let active = true;

    loadLocationsOnce().then(
      (dataset) => {
        if (active) setSnapshot({ dataset, error: null, generation });
      },
      (error: unknown) => {
        if (!active) return;
        setSnapshot({
          dataset: null,
          error: error instanceof Error ? error : new Error(String(error)),
          generation,
        });
      },
    );

    return () => {
      active = false;
    };
  }, [generation]);

  const reload = useCallback(() => {
    resetDatasetCache();
    setSnapshot(INITIAL);
    setGeneration((value) => value + 1);
  }, []);

  return useMemo<DatasetState>(() => {
    const dataset = snapshot.dataset;
    if (dataset === null) {
      return {
        status: snapshot.error === null ? 'loading' : 'error',
        locations: NO_LOCATIONS,
        byId: NO_BY_ID,
        coords: NO_COORDS,
        metadata: null,
        error: snapshot.error,
        reload,
      };
    }
    return {
      status: 'ready',
      locations: dataset.locations,
      byId: dataset.byId,
      coords: dataset.coords,
      metadata: dataset.metadata,
      error: null,
      reload,
    };
  }, [snapshot, reload]);
}
