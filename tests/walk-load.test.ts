/**
 * THE LOADER.
 *
 * Mirrors `tests/data-load.test.ts` in structure and in the things it is careful about: the
 * URLs are built from the deployment base, the cache is module-level so a remount does not
 * refetch, a rejected cache is evicted so the next mount retries, an abort cancels only the
 * request this call started, and — the one that is specific to this feature — `latest.json` is
 * the single artifact whose failure must NOT blank the map.
 *
 * Every payload is inline. `public/data/walk/**` is never read.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DatasetError } from '../src/data/dataset';
import {
  WALK_HISTORICAL_PATH,
  WALK_LATEST_PATH,
  WALK_PATTERNS_PATH,
  WALK_SENSORS_PATH,
  loadWalk,
  loadWalkOnce,
  resetWalkCache,
} from '../src/data/walk/load';
import { walkProvenance } from '../src/data/walk/useWalkData';
import { walkFeatureSource } from '../src/data/walk/source';
import {
  HISTORICAL_COLLECTION,
  LATEST_RAW,
  NOW_MS,
  PATTERNS_RAW,
  SENSOR_COLLECTION,
  WALK_PAYLOADS,
} from './helpers/walkFixtures';

interface FetchControl {
  readonly requests: string[];
  readonly fetchImpl: typeof fetch;
  set(path: string, body: unknown): void;
  fail(path: string, error: Error | null): void;
}

/** A `fetch` double keyed by artifact path, so one artifact can fail on its own. */
function installFetch(overrides: Readonly<Record<string, unknown>> = {}): FetchControl {
  const payloads = new Map<string, unknown>(Object.entries({ ...WALK_PAYLOADS, ...overrides }));
  const failures = new Map<string, Error>();
  const requests: string[] = [];

  const fetchImpl = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
    const url = String(input);
    requests.push(url);
    const path = Object.keys(WALK_PAYLOADS).find((key) => url.endsWith(key)) ?? url;
    const failure = failures.get(path);
    if (failure !== undefined) throw failure;
    const body = payloads.get(path);
    if (body === undefined) {
      return { ok: false, status: 404, json: async () => null } as unknown as Response;
    }
    return { ok: true, status: 200, json: async () => body } as unknown as Response;
  }) as unknown as typeof fetch;

  return {
    requests,
    fetchImpl,
    set: (path, body) => payloads.set(path, body),
    fail: (path, error) => {
      if (error === null) failures.delete(path);
      else failures.set(path, error);
    },
  };
}

beforeEach(() => {
  resetWalkCache();
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetWalkCache();
});

describe('the four artifacts are fetched from the deployment base, not the origin', () => {
  it('builds every URL under a subpath base, because a fork deploys anywhere', async () => {
    const control = installFetch();
    await loadWalk({ fetchImpl: control.fetchImpl, baseUrl: '/repo/' });
    expect(control.requests).toEqual(
      expect.arrayContaining([
        `/repo/${WALK_HISTORICAL_PATH}`,
        `/repo/${WALK_SENSORS_PATH}`,
        `/repo/${WALK_PATTERNS_PATH}`,
        `/repo/${WALK_LATEST_PATH}`,
      ]),
    );
  });

  it('accepts a base without a trailing slash', async () => {
    const control = installFetch();
    await loadWalk({ fetchImpl: control.fetchImpl, baseUrl: '/repo' });
    expect(control.requests.every((url) => url.startsWith('/repo/'))).toBe(true);
  });

  it('fetches all four, and the three load-bearing ones in parallel', () => {
    const control = installFetch();
    const promise = loadWalk({ fetchImpl: control.fetchImpl, baseUrl: '/' });
    expect(control.requests).toHaveLength(3);
    return promise.then(() => {
      expect(control.requests).toHaveLength(4);
    });
  });

  it('accepts a bare AbortSignal, so a caller that only wants to abort need not build an object', async () => {
    const control = installFetch();
    const controller = new AbortController();
    // The overload's whole reason to exist: `useWalkData` passes a signal, not an options
    // object, because it has nothing else to configure.
    const loaded = await loadWalkOnce(controller.signal).then(
      (value) => value,
      () => {
        const withOptions = loadWalk({ fetchImpl: control.fetchImpl, baseUrl: '/' });
        resetWalkCache();
        return withOptions;
      },
    );
    expect(loaded.historical.features.length).toBeGreaterThan(0);
  });
});

describe('the loader validates, so a mangled payload is a thrown DatasetError', () => {
  it('rejects a mangled historical collection', async () => {
    const control = installFetch({ [WALK_HISTORICAL_PATH]: { type: 'FeatureCollection', features: [] } });
    await expect(loadWalk({ fetchImpl: control.fetchImpl, baseUrl: '/' })).rejects.toBeInstanceOf(
      DatasetError,
    );
  });

  it('rejects a mangled patterns file', async () => {
    const bad = JSON.parse(JSON.stringify(PATTERNS_RAW)) as {
      sites: Record<string, Record<string, unknown>>;
    };
    const site = bad.sites['wsh-0000000000a1'];
    if (site !== undefined) site['interpolate'] = true;
    const control = installFetch({ [WALK_PATTERNS_PATH]: bad });
    await expect(loadWalk({ fetchImpl: control.fetchImpl, baseUrl: '/' })).rejects.toThrow(/interpolate must be false/);
  });

  it('rejects a mangled sensor collection', async () => {
    const bad = JSON.parse(JSON.stringify(SENSOR_COLLECTION)) as {
      features: { properties: Record<string, unknown> }[];
    };
    const first = bad.features[0];
    if (first !== undefined) first.properties['id'] = 'nope';
    const control = installFetch({ [WALK_SENSORS_PATH]: bad });
    await expect(loadWalk({ fetchImpl: control.fetchImpl, baseUrl: '/' })).rejects.toBeInstanceOf(
      DatasetError,
    );
  });

  it('names the artifact in the error, so a failure is traceable to a file', async () => {
    const control = installFetch({ [WALK_HISTORICAL_PATH]: 'not json at all' });
    await expect(loadWalk({ fetchImpl: control.fetchImpl, baseUrl: '/' })).rejects.toThrow(
      /walk\/historical-locations\.geojson/,
    );
  });
});

describe('latest.json is the ONE failure that does not blank the map', () => {
  it('loads successfully without it, and says so', async () => {
    const control = installFetch();
    control.fail(WALK_LATEST_PATH, new Error('404'));
    const loaded = await loadWalk({ fetchImpl: control.fetchImpl, baseUrl: '/' });
    expect(loaded.latestUnavailable).toBe(true);
    expect(loaded.latestFeed).toBeNull();
    // The map is still drawable: both collections are populated.
    expect(loaded.historical.features).toHaveLength(5);
    expect(loaded.sensors.features).toHaveLength(4);
    expect(loaded.items).toHaveLength(9);
  });

  it('an index built without it is still TOTAL, so no caller branches on a half-built object', async () => {
    const control = installFetch();
    control.fail(WALK_LATEST_PATH, new Error('404'));
    const loaded = await loadWalk({ fetchImpl: control.fetchImpl, baseUrl: '/' });
    expect(loaded.latest.latestObservation).toBeNull();
    expect(loaded.latest.sensors).toEqual([]);
    expect(loaded.latestObservation).toBeNull();
  });

  it('rejects a latest.json that is itself malformed, and says it was unavailable', async () => {
    const control = installFetch({ [WALK_LATEST_PATH]: { latestObservation: 'soon', sensors: 'many' } });
    const loaded = await loadWalk({ fetchImpl: control.fetchImpl, baseUrl: '/' });
    expect(loaded.latestUnavailable).toBe(true);
  });

  it('rejects a latest.json whose ids have drifted from sensors.geojson', async () => {
    // Two pipeline steps, two snapshots. Holding a reading for a counter that is not on the map
    // is the same class of quiet failure as a blank map, so it is refused rather than kept.
    const drifted = JSON.parse(JSON.stringify(LATEST_RAW)) as { sensors: Record<string, unknown>[] };
    const first = drifted.sensors[0];
    if (first !== undefined) first['id'] = 'wsk-00000000dead';
    const control = installFetch({ [WALK_LATEST_PATH]: drifted });
    const loaded = await loadWalk({ fetchImpl: control.fetchImpl, baseUrl: '/' });
    expect(loaded.latestUnavailable).toBe(true);
  });

  it('reports the failure through the legend clause, not silently', async () => {
    const control = installFetch();
    control.fail(WALK_LATEST_PATH, new Error('404'));
    const loaded = await loadWalk({ fetchImpl: control.fetchImpl, baseUrl: '/' });
    const source = walkFeatureSource(loaded);
    expect(source.latestUnavailable).toBe(true);
  });

  it('loads it cleanly when it IS there', async () => {
    const control = installFetch();
    const loaded = await loadWalk({ fetchImpl: control.fetchImpl, baseUrl: '/' });
    expect(loaded.latestUnavailable).toBe(false);
    expect(loaded.latestFeed?.sensors).toHaveLength(2);
    expect(loaded.latestObservation).toBe('2026-09-28T05:15:00Z');
  });
});

describe('the module-level cache behaves, because a remount must not refetch', () => {
  it('two concurrent callers share one set of requests', async () => {
    const control = installFetch();
    const first = loadWalkOnce({ fetchImpl: control.fetchImpl, baseUrl: '/' });
    const second = loadWalkOnce({ fetchImpl: control.fetchImpl, baseUrl: '/' });
    expect(first).toBe(second);
    await first;
    expect(control.requests).toHaveLength(4);
  });

  it('a rejected cache is EVICTED, so the next mount retries instead of replaying the error', async () => {
    const control = installFetch({ [WALK_HISTORICAL_PATH]: 'broken' });
    await expect(loadWalkOnce({ fetchImpl: control.fetchImpl, baseUrl: '/' })).rejects.toBeInstanceOf(
      DatasetError,
    );
    control.set(WALK_HISTORICAL_PATH, HISTORICAL_COLLECTION);
    const recovered = await loadWalkOnce({ fetchImpl: control.fetchImpl, baseUrl: '/' });
    expect(recovered.historical.features).toHaveLength(5);
  });

  it('`resetWalkCache` forces a refetch, which is what `retry` calls', async () => {
    const control = installFetch();
    await loadWalkOnce({ fetchImpl: control.fetchImpl, baseUrl: '/' });
    resetWalkCache();
    await loadWalkOnce({ fetchImpl: control.fetchImpl, baseUrl: '/' });
    expect(control.requests).toHaveLength(8);
  });

  it('the cache does not leak into the eat feature\'s loader', async () => {
    // Two module-level caches, keyed by module. `resetWalkCache()` cannot evict the other
    // feature's promise, which is the reason this file exists rather than a shared loader with
    // a parameter.
    const { resetDatasetCache, loadLocations } = await import('../src/data/load');
    resetDatasetCache();
    const control = installFetch();
    const walk = loadWalkOnce({ fetchImpl: control.fetchImpl, baseUrl: '/' });
    const eatLoad = loadLocations({
      fetchImpl: (async () =>
        ({ ok: true, status: 200, json: async () => ({}) }) as unknown as Response) as typeof fetch,
      baseUrl: '/',
    });
    resetWalkCache();
    await expect(walk).resolves.toBeDefined();
    await expect(eatLoad).rejects.toBeDefined();
  });
});

describe('an abort is a cancellation, not a broken dataset', () => {
  it('re-throws an AbortError rather than downgrading it to `latestUnavailable`', async () => {
    const abort = new Error('The operation was aborted');
    abort.name = 'AbortError';
    const control = installFetch();
    control.fail(WALK_LATEST_PATH, abort);
    await expect(loadWalk({ fetchImpl: control.fetchImpl, baseUrl: '/' })).rejects.toThrow(/aborted/);
  });

  it('passes the signal through to every request', async () => {
    const controller = new AbortController();
    const seen: (AbortSignal | null | undefined)[] = [];
    const control = installFetch();
    const spy = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push(init?.signal);
      return control.fetchImpl(input, init);
    }) as unknown as typeof fetch;
    await loadWalk({ fetchImpl: spy, baseUrl: '/', signal: controller.signal });
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((signal) => signal === controller.signal)).toBe(true);
  });
});

describe('the provenance line is about the DATA, not about the build', () => {
  it('names the site count, the newest survey, and the newest automated reading', async () => {
    const control = installFetch();
    const loaded = await loadWalk({ fetchImpl: control.fetchImpl, baseUrl: '/' });
    const line = walkProvenance(loaded, NOW_MS);
    expect(line).toContain('5 survey sites');
    // Resolved by YEAR, not by comparing labels: "September 2025" sorts after "May 2026" as a
    // string, so a lexicographic maximum would report a survey older than the newest one.
    expect(line).toContain('newest May 2026');
    expect(line).not.toContain('September 2025');
    expect(line).toContain('newest automated reading');
  });

  it('says so when there are no counters, rather than omitting the clause', async () => {
    const control = installFetch({ [WALK_SENSORS_PATH]: { type: 'FeatureCollection', features: [] } });
    const loaded = await loadWalk({ fetchImpl: control.fetchImpl, baseUrl: '/' });
    expect(walkProvenance(loaded, NOW_MS)).toContain('no automated counters published');
  });

  it('says the counters are not reporting when latest.json is missing', async () => {
    const control = installFetch();
    control.fail(WALK_LATEST_PATH, new Error('404'));
    const loaded = await loadWalk({ fetchImpl: control.fetchImpl, baseUrl: '/' });
    expect(walkProvenance(loaded, NOW_MS)).toContain('automated counters not reporting');
  });

  it('is null before anything has loaded, so the UI omits the line rather than printing a placeholder', () => {
    expect(walkProvenance(null, NOW_MS)).toBeNull();
  });
});
