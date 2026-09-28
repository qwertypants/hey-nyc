/**
 * THE HOOK, not the feature — the walk counterpart of `src/features/eat/useEatFeature.ts`.
 *
 * Two lines of connection and nothing else:
 *
 *   const walk = useWalkFeature(enabled);
 *   const feature = useMemo(() => createWalkFeature(data, source), [data, source]);
 *
 * `enabled` is `true` only while Where NYC Walks is the selected feature, which is what makes
 * the four artifact requests lazy. The hook is still CALLED every render, because React
 * forbids the alternative; `useWalkData` turns the flag into a property of the request.
 *
 * THE MEMO IS THE FEATURE CACHE. The shell keeps one feature object per id for as long as
 * the app is open, and this is what makes it: a rebuild happens when the artifacts change,
 * which is a retry, and not when the visitor switches away and back. That is why switching
 * back to walk is instant and does not refetch — and why
 * `tests/feature-switching.test.tsx` can assert one request per artifact across four
 * switches.
 *
 * Public surface:
 *   useWalkFeature(enabled): WalkFeature
 */

import { useMemo } from 'react';
import { useWalkData } from '../../data/walk/useWalkData';
import { createWalkFeature } from './feature';
import type { WalkFeature } from './feature';

export function useWalkFeature(enabled: boolean): WalkFeature {
  const { data, source } = useWalkData({ enabled });

  return useMemo(() => createWalkFeature(data, source), [data, source]);
}
