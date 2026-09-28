/**
 * THE HOOK, not the feature.
 *
 * `createEatFeature` is pure and takes its data as an argument, so the layer code, the list
 * predicate and the chrome can be unit-tested and reasoned about without React. This file is
 * the two lines that connect it to the real loader, and nothing else:
 *
 *   const dataset = useDataset();
 *   const collection = useLocationCollection(dataset.status);
 *   return useMemo(() => createEatFeature({ ...dataset, collection }), [dataset, collection]);
 *
 * THE MEMO IS THE FEATURE CACHE. The shell keeps one feature object per id for as long as
 * the app is open, and this is what makes it: a rebuild happens when the artifacts change,
 * which is a retry, and not when the visitor switches away and back. That is why switching
 * back to Eat Outside is instant and does not refetch.
 *
 * Public surface:
 *   useEatFeature(): EatFeature
 */

import { useMemo } from 'react';
import { useDataset } from '../../data/useDataset';
import type { DatasetStatus } from '../../data/useDataset';
import { useLocationCollection } from '../../hooks/useLocationCollection';
import { createEatFeature } from './eatFeature';
import type { EatFeature } from './eatFeature';

export function useEatFeature(): EatFeature {
  const dataset = useDataset();
  const collection = useLocationCollection(dataset.status);

  /*
   * THE FEATURE IS NOT USABLE UNTIL IT HAS BOTH HALVES.
   *
   * `useDataset` resolves the records and `useLocationCollection` resolves the FeatureCollection
   * the map source needs, and the second arrives from the same cached promise ONE RENDER
   * LATER than the first. Reporting `ready` on the first of those two renders is not a
   * cosmetic lie: the shell mounts a feature as soon as it says `ready`, so a feature that
   * said `ready` with no collection would be mounted with nothing to draw and then replaced a
   * render later — a remount under the visitor's cursor, which silently eats a click on a
   * filter chip.
   *
   * So `ready` means what it says: there is something to count AND something to draw. It also
   * restores what the app did before the registry, when the loading card covered the frame in
   * which the collection had not yet arrived.
   */
  const usable = dataset.status === 'ready' && collection !== null;
  // `loading`, not `dataset.status`, in the gap: the records have arrived but the map source
  // has not, and a feature that said `ready` there would be mounted with nothing to draw.
  const status: DatasetStatus = usable
    ? 'ready'
    : dataset.status === 'ready'
      ? 'loading'
      : dataset.status;

  return useMemo(
    () =>
      createEatFeature({
        status,
        locations: dataset.locations,
        byId: dataset.byId,
        coords: dataset.coords,
        collection,
        metadata: dataset.metadata,
        error: dataset.error,
        retry: dataset.reload,
      }),
    [dataset, collection, status],
  );
}
