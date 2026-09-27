/**
 * The GeoJSON `FeatureCollection` the map needs, from the load the app already made.
 *
 * WHY THIS EXISTS. `useDataset()` deliberately exposes `locations`, `byId`, `coords` and
 * `metadata` — everything a UI wants — but NOT `collection`, because nothing in the data
 * layer should know that MapLibre exists. `createMapController` needs exactly that
 * collection, so something has to bridge the two. Rebuilding it here would mean
 * re-materialising 2 000 features from the flat list, which is a re-implementation of
 * `indexCollection` and a chance to silently drop a point.
 *
 * Instead this asks the module-level cache that `useDataset` is already reading:
 * `loadLocationsOnce()` returns the SAME in-flight-or-settled promise, so there is still
 * exactly one network request. Because `useDataset.reload()` calls `resetDatasetCache()`
 * and passes through a `loading` state before `ready` again, keying this effect on the
 * dataset status keeps the two in lockstep across a retry.
 *
 * Public surface:
 *   useLocationCollection(status: DatasetStatus): LocationCollection | null
 */

import { useEffect, useState } from 'react';
import { loadLocationsOnce } from '../data/load';
import type { DatasetStatus } from '../data/useDataset';
import type { LocationCollection } from '../types/location';

export function useLocationCollection(status: DatasetStatus): LocationCollection | null {
  const [collection, setCollection] = useState<LocationCollection | null>(null);

  useEffect(() => {
    if (status !== 'ready') {
      // A retry that failed must not leave the previous collection on screen next to an
      // error message.
      setCollection(null);
      return;
    }

    let active = true;
    void loadLocationsOnce().then(
      (dataset) => {
        if (active) setCollection(dataset.collection);
      },
      () => {
        // `useDataset` already owns the error surface; here it just means "no map".
        if (active) setCollection(null);
      },
    );

    return () => {
      active = false;
    };
  }, [status]);

  return collection;
}
