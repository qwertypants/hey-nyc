/**
 * THE CATALOG — the only place that knows a feature exists.
 *
 * `src/App.tsx` asks for "the feature for this id" and gets one. It does not import Eat
 * Outside, it does not know what a borough is, and adding a third feature is a line in the
 * switch below rather than a branch through the component tree. That is the whole point of
 * `src/features/registry.ts`, and this file is where the promise is kept.
 *
 * WHY EVERY HOOK IS CALLED, ALWAYS. React forbids calling a hook conditionally, so "only
 * load walk's data when walk is selected" cannot be expressed by not calling the hook. It
 * is expressed by the `enabled` argument: `useWalkFeature(false)` renders
 * nothing and requests nothing, and only when the visitor picks walk does it ask for data.
 * The lazy load is therefore a property of the REQUEST, not of the render tree, and it is
 * testable — `tests/feature-switching.test.tsx` asserts the walk artifact is requested once
 * across four switches, and never before the first one.
 *
 * WHY THE IDENTITIES ARE SEPARATE from the feature objects. The switcher must render its
 * two options — names, descriptions — before either feature has any data, and while one of
 * them is still loading. So each feature module exports its identity as a constant, and the
 * catalog lists them. Nothing here constructs a feature to show a label.
 *
 * Public surface:
 *   FEATURE_IDENTITIES, useFeatureCatalog(id)
 *   type FeatureCatalogResult
 */

import { useMemo } from 'react';
import type { FeatureId, FeatureIdentity } from '../registry';
import { DEFAULT_FEATURE_ID } from '../../lib/urlState';
import type { AnyFeature } from '../registry';
import { useEatFeature } from '../eat/useEatFeature';
import { EAT_IDENTITY } from '../eat/eatFeature';
import { WALK_IDENTITY } from '../walk/legend';
import { useWalkFeature } from '../walk/useWalkFeature';

/**
 * Every feature the app advertises, in the order the switcher shows them.
 *
 * TO ADD A FEATURE: add its id to `FeatureId` in `src/features/registry.ts` and to
 * `FEATURE_IDS` in `src/lib/urlState.ts` (the URL is what makes `?mode=` mean something),
 * then add one entry here. Nothing under `src/features/shell/` and nothing in `App.tsx`
 * changes.
 */
export const FEATURE_IDENTITIES: readonly FeatureIdentity[] = [EAT_IDENTITY, WALK_IDENTITY];

/**
 * The one place a feature id chooses a feature object, written as an exhaustive `switch` so
 * that adding a third id to `FeatureId` is a COMPILE ERROR here rather than a silent fall
 * through to the wrong feature. A ternary would have quietly defaulted a new feature to
 * walk, which is the exact failure a registry exists to prevent.
 */
function selectFeature(id: FeatureId, eat: AnyFeature, walk: AnyFeature): AnyFeature {
  switch (id) {
    case 'eat':
      return eat;
    case 'walk':
      return walk;
  }
}

export interface FeatureCatalogResult {
  /** The selected feature. Never null: a feature exists before its data does. */
  readonly feature: AnyFeature;
  /** Every advertised feature, for the switcher. */
  readonly features: readonly FeatureIdentity[];
  readonly defaultId: FeatureId;
}

export function useFeatureCatalog(id: FeatureId): FeatureCatalogResult {
  const eat = useEatFeature();
  const walk = useWalkFeature(id === 'walk');

  const feature = selectFeature(id, eat, walk);

  return useMemo(
    () => ({ feature, features: FEATURE_IDENTITIES, defaultId: DEFAULT_FEATURE_ID }),
    [feature],
  );
}
