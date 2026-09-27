/**
 * INTEGRATION NOTES (src/data/load.ts)
 *
 * Fetches the two published artifacts and validates them. No React, no MapLibre, so
 * `tests/data-load.test.ts` can call it with a mocked `fetch` and inline fixtures.
 *
 * URLs are built from `import.meta.env.BASE_URL` (see `src/lib/env.ts`), never a leading
 * "/", because the app is deployed to a repository subpath such as
 * `https://<user>.github.io/eat-outside-nyc/`. `VITE_BASE_PATH` defaults to `"./"` in
 * vite.config.ts, which is exactly what makes a fork work on any path.
 *
 * Public surface:
 *   LOCATIONS_PATH, METADATA_PATH, LoadedDataset, LoadOptions
 *   assetUrl(path, base?): string
 *   loadLocations(signal?: AbortSignal): Promise<LoadedDataset>
 *   loadLocations(options: LoadOptions): Promise<LoadedDataset>
 *   loadLocationsOnce(): Promise<LoadedDataset>
 *   resetDatasetCache(): void
 *
 * Cache: `loadLocations()` always hits the network (so `reload` and tests are honest).
 * `loadLocationsOnce()` is the shared, module-level promise the hook uses, which is why a
 * React remount never refetches. A rejected cached promise is evicted so the next mount
 * retries instead of replaying the same error forever.
 *
 * `loadLocations` is overloaded so a caller that only wants to abort can pass a bare
 * `AbortSignal` while tests can inject a `fetch` and a `baseUrl` through `LoadOptions`.
 * Stream C should normally use `useDataset()` instead of calling this directly.
 */

import type { DatasetMetadata } from '../types/location';
import { indexCollection, validateCollection, validateMetadata } from './dataset';
import type { DatasetIndex } from './dataset';

export const LOCATIONS_PATH = 'data/cafes.geojson';
export const METADATA_PATH = 'data/metadata.json';

export interface LoadedDataset extends DatasetIndex {
  readonly metadata: DatasetMetadata;
}

export interface LoadOptions {
  /** Abort the in-flight requests. */
  readonly signal?: AbortSignal;
  /** Injectable for tests. Defaults to the global `fetch`. */
  readonly fetchImpl?: typeof fetch;
  /** Overrides `import.meta.env.BASE_URL`. Tests pass `'/'` or `'/repo/'`. */
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

/** Joins a repository-relative artifact path onto the deployment base. */
export function assetUrl(path: string, base: string = defaultBaseUrl()): string {
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

/**
 * Loads and validates `cafes.geojson` + `metadata.json` in parallel. Throws
 * `DatasetError` (or a network `Error`) on any problem — the app must show an error state
 * rather than an empty map.
 */
export function loadLocations(signal?: AbortSignal): Promise<LoadedDataset>;
export function loadLocations(options: LoadOptions): Promise<LoadedDataset>;
export async function loadLocations(
  argument?: AbortSignal | LoadOptions,
): Promise<LoadedDataset> {
  const resolved: LoadOptions = isAbortSignal(argument) ? { signal: argument } : (argument ?? {});

  const doFetch = resolved.fetchImpl ?? (typeof fetch === 'function' ? fetch : undefined);
  if (doFetch === undefined) throw new Error('fetch is unavailable in this environment');

  const base = resolved.baseUrl ?? defaultBaseUrl();
  const [rawCollection, rawMetadata] = await Promise.all([
    fetchJson(assetUrl(LOCATIONS_PATH, base), doFetch, resolved.signal),
    fetchJson(assetUrl(METADATA_PATH, base), doFetch, resolved.signal),
  ]);

  const collection = validateCollection(rawCollection);
  const metadata = validateMetadata(rawMetadata);
  return { ...indexCollection(collection), metadata };
}

let cached: Promise<LoadedDataset> | null = null;

/**
 * The shared promise. Concurrent and repeated callers reuse the same network request.
 *
 * `signal` only applies when THIS call is the one that starts the request; a cache hit
 * hands back the in-flight request untouched, so one consumer unmounting can never cancel
 * another consumer's load. Rejections are evicted so the next mount retries.
 */
export function loadLocationsOnce(signal?: AbortSignal): Promise<LoadedDataset> {
  if (cached === null) {
    cached = loadLocations(signal).catch((error: unknown) => {
      cached = null;
      throw error;
    });
  }
  return cached;
}

export function resetDatasetCache(): void {
  cached = null;
}
