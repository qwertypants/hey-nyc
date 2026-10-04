import { useCallback, useEffect, useMemo, useState } from 'react';
import { createStorefrontFeature } from './feature';
import { loadStorefrontSharedOnce, loadStorefrontsOnce, resetStorefrontCache } from './load';
import type { StorefrontMetadata } from '../../types/storefronts';
import type { LoadedStorefronts } from './load';
export function useStorefrontFeature(enabled: boolean, year = '2024') {
  const [loaded, setLoaded] = useState<{ year: string; data: LoadedStorefronts } | null>(null);
  const [error, setError] = useState<{ year: string; error: Error } | null>(null);
  const [metadata, setMetadata] = useState<StorefrontMetadata | null>(null);
  const [generation, setGeneration] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    let active = true;
    void loadStorefrontSharedOnce().then((shared) => { if (active) setMetadata(shared.metadata); }, () => undefined);
    void loadStorefrontsOnce(year).then((result) => { if (active) { setLoaded({ year, data: result }); setError(null); } }, (failure: unknown) => { if (active) setError({ year, error: failure instanceof Error ? failure : new Error(String(failure)) }); });
    return () => { active = false; };
  }, [enabled, year, generation]);
  const retry = useCallback(() => { resetStorefrontCache(); setLoaded(null); setError(null); setGeneration((n) => n + 1); }, []);
  const current = loaded?.year === year ? loaded.data : null;
  const currentError = error?.year === year ? error.error : null;
  return useMemo(() => createStorefrontFeature(current, current ? 'ready' : currentError ? 'error' : 'loading', currentError, retry, metadata), [current, currentError, retry, metadata]);
}
