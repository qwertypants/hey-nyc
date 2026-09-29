/**
 * INTEGRATION NOTES (src/data/walk/load.ts)
 *
 * Fetches and validates the four Where NYC Walks artifacts. No React, no MapLibre, so the
 * tests can call it with a mocked `fetch` and inline fixtures.
 *
 * Mirrors `src/data/load.ts` in every decision that matters, including the one that looks
 * like an oversight: `latest.json` is loaded and validated but is NEVER allowed to fail the
 * load. The other three artifacts are the map — a failure there is an error state the visitor
 * sees. `latest.json` is a redundant restatement of fields that `sensors.geojson` already
 * carries, published by a different pipeline step; if it is missing, the feature runs on the
 * collection and the staleness wording falls back to `sensors.geojson`'s own
 * `lastObservation`. Losing it degrades one sentence; failing the whole feature would show
 * a red card over a map that is perfectly drawable.
 *
 * `id` namespaces the module-level cache, so `resetDatasetCache()` cannot evict the eat
 * feature's promise and vice versa. Two features, one module-level cache each, no
 * interference — the reason this file exists rather than a shared loader with a parameter.
 *
 * URLs are built from `import.meta.env.BASE_URL` (see `src/lib/env.ts`), never a leading "/",
 * because the app deploys to a repository subpath such as
 * `https://<user>.github.io/eat-outside-nyc/`.
 *
 * Public surface:
 *   WALK_HISTORICAL_PATH, WALK_PATTERNS_PATH, WALK_SENSORS_PATH, WALK_LATEST_PATH
 *   LoadedWalk, WalkLoadOptions
 *   loadWalk(options?): Promise<LoadedWalk>
 *   loadWalkOnce(options?): Promise<LoadedWalk>
 *   resetWalkCache(): void
 */

import type { HistoricalCollection, SensorCollection } from '../../types/walk';
import {
  checkLatestAgainstSensors,
  indexWalk,
  validateHistoricalCollection,
  validateHistoricalPatterns,
  validateLatest,
  validateSensorCollection,
} from './validate';
import type { WalkIndex, WalkLatest, WalkPatterns } from './validate';

export const WALK_HISTORICAL_PATH = 'data/walk/historical-locations.geojson';
export const WALK_PATTERNS_PATH = 'data/walk/historical-patterns.json';
export const WALK_SENSORS_PATH = 'data/walk/sensors.geojson';
export const WALK_LATEST_PATH = 'data/walk/latest.json';

export interface LoadedWalk extends WalkIndex {
  /**
   * What `latest.json` said, or null when it could not be loaded. The red flag on the UI.
   * `WalkIndex.latest` is always populated — with an empty feed in that case — so nothing
   * downstream has to branch on a half-built object.
   */
  readonly latestFeed: WalkLatest | null;
  /** True when the load itself failed. Rendered in the legend, never silently swallowed. */
  readonly latestUnavailable: boolean;
}

export interface WalkLoadOptions {
  readonly signal?: AbortSignal;
  /** Injectable for tests. Defaults to the global `fetch`. */
  readonly fetchImpl?: typeof fetch;
  /** Overrides `import.meta.env.BASE_URL`. */
  readonly baseUrl?: string;
}

function defaultBaseUrl(): string {
  const base = import.meta.env?.BASE_URL;
  return typeof base === 'string' && base.length > 0 ? base : '/';
}

function isAbortSignal(value: unknown): value is AbortSignal {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as AbortSignal).aborted === 'boolean' &&
    typeof (value as AbortSignal).addEventListener === 'function'
  );
}

function assetUrl(path: string, base: string): string {
  const prefix = base.endsWith('/') ? base : `${base}/`;
  return `${prefix}${path.replace(/^\/+/, '')}`;
}

async function fetchJson(
  url: string,
  doFetch: typeof fetch,
  signal: AbortSignal | undefined,
): Promise<unknown> {
  const init: RequestInit = { headers: { Accept: 'application/json' } };
  if (signal !== undefined) init.signal = signal;

  const response = await doFetch(url, init);
  if (!response.ok) {
    throw new Error(`Request for ${url} failed with status ${response.status}`);
  }
  return (await response.json()) as unknown;
}

/** An `AbortError` is a cancelled request, not a broken dataset, so it is not downgraded. */
function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

export async function loadWalk(
  options: WalkLoadOptions | AbortSignal = {},
): Promise<LoadedWalk> {
  const resolved: WalkLoadOptions = isAbortSignal(options) ? { signal: options } : options;

  const doFetch = resolved.fetchImpl ?? (typeof fetch === 'function' ? fetch : undefined);
  if (doFetch === undefined) throw new Error('fetch is unavailable in this environment');

  const base = resolved.baseUrl ?? defaultBaseUrl();

  // The three load-bearing artifacts, in parallel. Any failure here fails the load.
  const [rawHistorical, rawSensors, rawPatterns] = await Promise.all([
    fetchJson(assetUrl(WALK_HISTORICAL_PATH, base), doFetch, resolved.signal),
    fetchJson(assetUrl(WALK_SENSORS_PATH, base), doFetch, resolved.signal),
    fetchJson(assetUrl(WALK_PATTERNS_PATH, base), doFetch, resolved.signal),
  ]);

  const historical: HistoricalCollection = validateHistoricalCollection(rawHistorical);
  const sensors: SensorCollection = validateSensorCollection(rawSensors);
  const patterns: WalkPatterns = validateHistoricalPatterns(rawPatterns);

  // The one tolerated failure. See the module header.
  let latest: WalkLatest | null = null;
  let latestUnavailable = false;
  try {
    const rawLatest = await fetchJson(assetUrl(WALK_LATEST_PATH, base), doFetch, resolved.signal);
    const parsed = validateLatest(rawLatest);
    checkLatestAgainstSensors(parsed, sensors);
    latest = parsed;
  } catch (error) {
    if (isAbort(error)) throw error;
    latestUnavailable = true;
  }

  return {
    ...indexWalk(historical, sensors, patterns, latest ?? EMPTY_LATEST),
    latestFeed: latest,
    latestUnavailable,
  };
}

/**
 * What `indexWalk` reads when `latest.json` is absent. A real shape rather than `null` in
 * every field, so no caller has to branch on a half-built object.
 */
const EMPTY_LATEST: WalkLatest = { latestObservation: null, sensors: [] };

let cached: Promise<LoadedWalk> | null = null;

/**
 * The shared promise. Concurrent and repeated callers reuse the same network request, and a
 * rejection is evicted so the next mount retries instead of replaying the error forever.
 *
 * `options` is accepted for the injected `fetch`, tests and an explicit signal, but the
 * `signal` is deliberately NOT handed to the underlying fetch. This promise is module-level
 * and outlives every caller, while a caller's signal does not: under StrictMode the first
 * mount's cleanup would abort the request and the second mount would be handed the same
 * dead promise. See the identical note in `src/data/load.ts`.
 */
export function loadWalkOnce(options: WalkLoadOptions | AbortSignal = {}): Promise<LoadedWalk> {
  if (cached === null) {
    const { signal: _signal, ...fetchOptions } = isAbortSignal(options) ? { signal: options } : options;
    cached = loadWalk(fetchOptions).catch((error: unknown) => {
      cached = null;
      throw error;
    });
  }
  return cached;
}

export function resetWalkCache(): void {
  cached = null;
}
