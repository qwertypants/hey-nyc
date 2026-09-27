/**
 * The URL is the app's save file. Read once, written back continuously.
 *
 * Reading: `readInitialUrlState()` runs ONCE per app load, from a lazy `useState`
 * initialiser, before the map controller is created. Everything after that comes from
 * `parseUrlState`, which never throws for any input — a hostile, truncated or hand-edited
 * query string degrades to the default citywide view and no filters, and the app renders.
 *
 * Writing: `useUrlStateSync` mirrors the map view, the filters and the selection into the
 * query string with `history.replaceState`, debounced. `replaceState` rather than
 * `pushState` because panning a map must not fill the Back button with 200 history entries,
 * and a shared link should be one link, not a replay of a tour.
 *
 * There is deliberately NO hook here for the visitor's geolocation, and none may be added:
 * `UrlState` has no member that can hold one, and `serializeUrlState` writes only the six
 * whitelisted keys. A shared link describes a map, never a person.
 *
 * Public surface:
 *   URL_WRITE_DEBOUNCE_MS
 *   readInitialUrlState(): UrlState
 *   useUrlStateSync(state, options?): void
 */

import { useEffect, useRef } from 'react';
import type { UrlState } from '../lib/urlState';
import { parseUrlState, serializeUrlState } from '../lib/urlState';

/**
 * Long enough that a pan produces one history write rather than one per frame, short
 * enough that a shared link is already correct by the time someone copies it.
 */
export const URL_WRITE_DEBOUNCE_MS = 300;

export function readInitialUrlState(): UrlState {
  if (typeof window === 'undefined') return parseUrlState('');
  return parseUrlState(window.location.search);
}

export interface UrlStateSyncOptions {
  /** False while the dataset is still loading, so the URL is not rewritten from defaults. */
  readonly enabled?: boolean;
  readonly delayMs?: number;
}

export function useUrlStateSync(state: UrlState, options: UrlStateSyncOptions = {}): void {
  const { enabled = true } = options;
  const requested = options.delayMs;
  const delayMs =
    requested !== undefined && Number.isFinite(requested) && requested >= 0
      ? requested
      : URL_WRITE_DEBOUNCE_MS;

  const lastWritten = useRef<string | null>(null);
  // Serialise during render so the effect only ever sees the latest value and the timer is
  // not restarted by a no-op re-render.
  const serialized = enabled ? serializeUrlState(state) : null;
  const serializedRef = useRef(serialized);
  serializedRef.current = serialized;

  useEffect(() => {
    const next = serializedRef.current;
    if (next === null) return;
    if (lastWritten.current === next) return;
    if (typeof window === 'undefined') return;

    const write = (): void => {
      const current = serializedRef.current;
      if (current === null || lastWritten.current === current) return;
      lastWritten.current = current;
      const { pathname, hash } = window.location;
      window.history.replaceState(window.history.state, '', `${pathname}${current}${hash}`);
    };

    if (delayMs === 0) {
      write();
      return;
    }

    const timer = window.setTimeout(write, delayMs);
    return () => window.clearTimeout(timer);
  }, [serialized, delayMs]);
}
