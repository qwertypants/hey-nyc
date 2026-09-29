/**
 * Drives the real `useDataset` hook through a mocked `fetch`.
 *
 * The point is that the loading / ready / error / retry states under test are the REAL
 * ones: `load.ts` builds the URLs, `dataset.ts` validates the payload, `useDataset` owns the
 * transitions. Only the network is replaced. A test that mocked the hook itself would pass
 * even if the loader were broken.
 *
 * The WALK artifacts are served from `tests/helpers/walkFixtures.ts` too, and they have to
 * be: the second feature is loaded by the real `useWalkData` through this same `fetch`, and a
 * test that switched to it and got the eat metadata fixture back would see a validation error
 * rather than a feature. The payloads are keyed by artifact path, which is exactly how
 * `src/data/walk/load.ts` asks for them.
 *
 * `resetDatasetCache()` matters: `loadLocationsOnce` is module-level, so a success from one
 * test would otherwise be replayed by the next and the fixture would never be re-read. The
 * walk loader memoises the same way and has its own `resetWalkCache`.
 *
 * Public surface:
 *   DatasetFetchOptions, DatasetFetchControl
 *   installDatasetFetch(options?): DatasetFetchControl
 */

import { vi } from 'vitest';
import { resetDatasetCache } from '../../src/data/load';
import { WALK_PAYLOADS } from './walkFixtures';

export interface DatasetFetchOptions {
  readonly collection?: unknown;
  readonly metadata?: unknown;
  /** When set, both requests reject with this error. */
  readonly fail?: Error | null;
  /** When true, requests hang until `release()` — the loading state. */
  readonly hang?: boolean;
}

export interface DatasetFetchControl {
  /** Answers with `collection` instead of the current one. */
  setCollection(value: unknown): void;
  setMetadata(value: unknown): void;
  /** `null` clears the failure, which is how a retry can succeed mid-test. */
  setFailure(error: Error | null): void;
  /** Stop hanging and answer the pending requests. */
  release(): void;
  /** Every URL requested, in order. */
  readonly requests: string[];
  /** Call `fetch` against the real `Response`-less contract `load.ts` uses. */
  readonly fetchImpl: typeof fetch;
}

/**
 * The walk artifact this URL names, or `undefined` for anything else. Keyed by path rather
 * than by `includes('walk')` so a request for a path the loader does not know about is a
 * miss and falls through, rather than being answered with the wrong artifact.
 */
function walkPayloadFor(url: string): unknown {
  for (const [path, payload] of Object.entries(WALK_PAYLOADS)) {
    if (url.includes(path)) return payload;
  }
  return undefined;
}

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body,
  } as unknown as Response;
}

export function installDatasetFetch(options: DatasetFetchOptions = {}): DatasetFetchControl {
  let collection: unknown = options.collection;
  let metadata: unknown = options.metadata;
  let failure: Error | null = options.fail ?? null;
  const requests: string[] = [];

  let releaseGate: () => void = () => undefined;
  const gate =
    options.hang === true
      ? new Promise<void>((resolve) => {
          releaseGate = resolve;
        })
      : Promise.resolve();

  const fetchImpl = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
    const url = String(input);
    requests.push(url);
    await gate;
    if (failure !== null) throw failure;
    const walk = walkPayloadFor(url);
    if (walk !== undefined) return jsonResponse(walk);
    return jsonResponse(url.includes('cafes.geojson') ? collection : metadata);
  }) as unknown as typeof fetch;

  const control: DatasetFetchControl = {
    requests,
    fetchImpl,
    setCollection(value: unknown) {
      collection = value;
    },
    setMetadata(value: unknown) {
      metadata = value;
    },
    setFailure(error: Error | null) {
      failure = error;
    },
    release: () => {
      releaseGate();
    },
  };

  return control;
}

/**
 * Installs the control and clears the module cache. Must run before every render, because
 * `loadLocationsOnce` memoises its promise for the lifetime of the test file.
 */
export function activateDatasetFetch(options: DatasetFetchOptions = {}): DatasetFetchControl {
  const control = installDatasetFetch(options);
  resetDatasetCache();
  vi.stubGlobal('fetch', control.fetchImpl);
  return control;
}
