import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  GEOCODER_CONTACT,
  MIN_REQUEST_INTERVAL_MS,
  NOMINATIM_ENDPOINT,
  NYC_VIEWBOX,
  RESULT_LIMIT,
  createRateLimiter,
  geocodeSearch,
} from '../src/lib/geocode';
import type { RateLimiter } from '../src/lib/geocode';

/** Never sleeps: the tests drive the limiter with a fake clock. */
const NO_WAIT: RateLimiter = { wait: () => Promise.resolve(0) };

interface FakeResponseInit {
  readonly ok?: boolean;
  readonly status?: number;
  readonly headers?: Record<string, string>;
  readonly json?: unknown;
}

function fakeResponse(init: FakeResponseInit = {}): Response {
  const headers = new Map<string, string>(Object.entries(init.headers ?? {}));
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    headers: { get: (name: string) => headers.get(name) ?? null },
    json: () => Promise.resolve(init.json ?? []),
  } as unknown as Response;
}

function place(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    place_id: 1,
    display_name: 'Astoria, Queens, New York, 11101, United States',
    lat: '40.7644',
    lon: '-73.9235',
    type: 'suburb',
    addresstype: 'suburb',
    importance: 0.62,
    ...overrides,
  };
}

function search(query: string, response: Response, extra: Record<string, unknown> = {}) {
  const fetchImpl = vi.fn().mockResolvedValue(response);
  return {
    fetchImpl,
    run: () =>
      geocodeSearch(query, {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        limiter: NO_WAIT,
        ...extra,
      }),
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('createRateLimiter', () => {
  it('does not delay the very first request', async () => {
    const limiter = createRateLimiter({ now: () => 1_000, sleep: () => Promise.resolve() });
    await expect(limiter.wait()).resolves.toBe(0);
  });

  it('makes a second request wait out the remainder of the interval', async () => {
    let clock = 10_000;
    const sleep = vi.fn().mockImplementation(() => {
      clock += MIN_REQUEST_INTERVAL_MS;
      return Promise.resolve();
    });
    const limiter = createRateLimiter({ now: () => clock, sleep });

    await expect(limiter.wait()).resolves.toBe(0);
    clock += 250;
    await expect(limiter.wait()).resolves.toBe(MIN_REQUEST_INTERVAL_MS - 250);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it('does not delay once the interval has genuinely elapsed', async () => {
    let clock = 10_000;
    const sleep = vi.fn().mockImplementation(() => Promise.resolve());
    const limiter = createRateLimiter({ now: () => clock, sleep });

    await limiter.wait();
    clock += MIN_REQUEST_INTERVAL_MS + 5;
    await expect(limiter.wait()).resolves.toBe(0);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('serialises concurrent callers instead of letting them all pass in one tick', async () => {
    // Three simultaneous searches must occupy three distinct slots: an `if (now - last <
    // 1000)` check alone would let all three through in the same millisecond.
    let clock = 50_000;
    const waits: number[] = [];
    const sleep = vi.fn().mockImplementation((ms: number) => {
      clock += ms;
      waits.push(ms);
      return Promise.resolve();
    });
    const limiter = createRateLimiter({ now: () => clock, sleep });

    await Promise.all([limiter.wait(), limiter.wait(), limiter.wait()]);
    expect(waits).toEqual([MIN_REQUEST_INTERVAL_MS, MIN_REQUEST_INTERVAL_MS]);
  });

  it('never goes below the Nominatim floor, whatever it is asked for', async () => {
    let clock = 0;
    const sleep = vi.fn().mockImplementation((ms: number) => {
      clock += ms;
      return Promise.resolve();
    });
    const limiter = createRateLimiter({ minIntervalMs: 5, now: () => clock, sleep });
    await limiter.wait();
    await expect(limiter.wait()).resolves.toBe(MIN_REQUEST_INTERVAL_MS);
  });
});

describe('geocodeSearch request shape', () => {
  it('sends the parameters Nominatim requires and biases towards NYC', async () => {
    const { fetchImpl, run } = search('astoria', fakeResponse({ json: [place()] }));
    const outcome = await run();

    expect(outcome.status).toBe('ok');
    const url = new URL(String(fetchImpl.mock.calls[0]?.[0]));
    expect(url.origin + url.pathname).toBe(NOMINATIM_ENDPOINT);
    expect(url.searchParams.get('q')).toBe('astoria');
    expect(url.searchParams.get('format')).toBe('jsonv2');
    expect(url.searchParams.get('limit')).toBe(String(RESULT_LIMIT));
    expect(url.searchParams.get('countrycodes')).toBe('us');
    expect(url.searchParams.get('viewbox')).toBe(NYC_VIEWBOX);
    expect(url.searchParams.get('bounded')).toBe('1');
    expect(url.searchParams.get('email')).toBe(GEOCODER_CONTACT);
  });

  it('trims the query before sending it', async () => {
    const { fetchImpl, run } = search('   union square   ', fakeResponse({ json: [place()] }));
    await run();
    const url = new URL(String(fetchImpl.mock.calls[0]?.[0]));
    expect(url.searchParams.get('q')).toBe('union square');
  });

  it('accepts an injected endpoint and never touches the network', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(fakeResponse({ json: [place()] }));
    await geocodeSearch('lic', {
      endpoint: 'https://example.test/search',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      limiter: NO_WAIT,
    });
    expect(String(fetchImpl.mock.calls[0]?.[0])).toContain('https://example.test/search?');
  });
});

describe('geocodeSearch results', () => {
  it('maps Nominatim places to a small typed result list', async () => {
    const outcome = await search('astoria', fakeResponse({ json: [place()] })).run();
    if (outcome.status !== 'ok') throw new Error(`expected ok, got ${outcome.status}`);
    expect(outcome.results).toEqual([
      {
        placeId: '1',
        label: 'Astoria, Queens, New York, 11101, United States',
        lat: 40.7644,
        lng: -73.9235,
        kind: 'suburb',
        importance: 0.62,
      },
    ]);
  });

  it('keeps at most the requested number of results', async () => {
    const many = Array.from({ length: 12 }, (_, index) => place({ place_id: index + 1 }));
    const outcome = await search('coffee', fakeResponse({ json: many })).run();
    if (outcome.status !== 'ok') throw new Error(`expected ok, got ${outcome.status}`);
    expect(outcome.results).toHaveLength(RESULT_LIMIT);
  });

  it('drops entries with no usable coordinates or label', async () => {
    const outcome = await search(
      'broken',
      fakeResponse({
        json: [
          place({ lat: 'not-a-number' }),
          place({ display_name: '   ' }),
          null,
          'nonsense',
          place({ place_id: 99 }),
        ],
      }),
    ).run();
    if (outcome.status !== 'ok') throw new Error(`expected ok, got ${outcome.status}`);
    expect(outcome.results).toHaveLength(1);
    expect(outcome.results[0]?.placeId).toBe('99');
  });

  it('reports an empty result set distinctly from a failure', async () => {
    const outcome = await search('zzzz', fakeResponse({ json: [] })).run();
    expect(outcome).toEqual({ status: 'empty', query: 'zzzz' });
  });

  it('rejects a non-array payload rather than trusting it', async () => {
    const outcome = await search('astoria', fakeResponse({ json: { error: 'rate limited' } })).run();
    expect(outcome.status).toBe('error');
  });
});

describe('geocodeSearch input guards', () => {
  it('rejects a blank or whitespace-only query without a request', async () => {
    for (const query of ['', '   ', '\n\t']) {
      const { fetchImpl, run } = search(query, fakeResponse());
      expect((await run()).status).toBe('invalid-query');
      expect(fetchImpl).not.toHaveBeenCalled();
    }
  });

  it('rejects an absurdly long query without a request', async () => {
    const { fetchImpl, run } = search('a'.repeat(500), fakeResponse());
    expect((await run()).status).toBe('invalid-query');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('does not issue a request when the caller has already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchImpl = vi.fn();
    const outcome = await geocodeSearch('astoria', {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      limiter: NO_WAIT,
      signal: controller.signal,
    });
    expect(outcome.status).toBe('error');
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('geocodeSearch failure handling', () => {
  it('treats 429 as "slow down" and reports the retry window without retrying', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(fakeResponse({ ok: false, status: 429, headers: { 'Retry-After': '30' } }));
    const outcome = await geocodeSearch('astoria', {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      limiter: NO_WAIT,
    });

    expect(outcome).toEqual({ status: 'rate-limited', query: 'astoria', retryAfterMs: 30_000 });
    // One call, never a retry: the public endpoint must not be hammered.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('falls back to the floor when a 429 carries no Retry-After', async () => {
    const outcome = await geocodeSearch('astoria', {
      fetchImpl: (async () => fakeResponse({ ok: false, status: 429 })) as unknown as typeof fetch,
      limiter: NO_WAIT,
    });
    expect(outcome).toEqual({
      status: 'rate-limited',
      query: 'astoria',
      retryAfterMs: MIN_REQUEST_INTERVAL_MS,
    });
  });

  it('treats 503 the same way, since it is the overloaded-endpoint response', async () => {
    const outcome = await geocodeSearch('astoria', {
      fetchImpl: (async () => fakeResponse({ ok: false, status: 503 })) as unknown as typeof fetch,
      limiter: NO_WAIT,
    });
    expect(outcome.status).toBe('rate-limited');
  });

  it('reports other HTTP failures with the status', async () => {
    const outcome = await geocodeSearch('astoria', {
      fetchImpl: (async () => fakeResponse({ ok: false, status: 500 })) as unknown as typeof fetch,
      limiter: NO_WAIT,
    });
    expect(outcome).toEqual({
      status: 'error',
      query: 'astoria',
      message: 'Nominatim responded 500',
    });
  });

  it('reports a network failure as offline', async () => {
    const outcome = await geocodeSearch('astoria', {
      fetchImpl: (async () => {
        throw new TypeError('Failed to fetch');
      }) as unknown as typeof fetch,
      limiter: NO_WAIT,
    });
    expect(outcome.status).toBe('offline');
  });

  it('reports an external abort as cancelled, not as a timeout', async () => {
    const controller = new AbortController();
    let resolveStarted: () => void = () => undefined;
    const fetchStarted = new Promise<void>((resolve) => {
      resolveStarted = resolve;
    });
    const fetchImpl = vi.fn().mockImplementation(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          resolveStarted();
          init?.signal?.addEventListener('abort', () => {
            const error = new Error('aborted');
            error.name = 'AbortError';
            reject(error);
          });
        }),
    );

    const pending = geocodeSearch('astoria', {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      limiter: NO_WAIT,
      signal: controller.signal,
    });
    // Abort only once the request is genuinely in flight, so this exercises the
    // mid-request path rather than the pre-flight guard.
    await fetchStarted;
    controller.abort();

    expect(await pending).toEqual({
      status: 'error',
      query: 'astoria',
      message: 'Search cancelled',
    });
  });

  it('bounds the request with a timeout and reports it as a timeout', async () => {
    const fetchImpl = vi.fn().mockImplementation(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            const error = new Error('aborted');
            error.name = 'AbortError';
            reject(error);
          });
        }),
    );

    const outcome = await geocodeSearch('astoria', {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      limiter: NO_WAIT,
      timeoutMs: 5,
    });
    expect(outcome).toEqual({ status: 'timeout', query: 'astoria' });
  });

  it('waits for the rate limiter before it issues a request', async () => {
    const order: string[] = [];
    const limiter: RateLimiter = {
      wait: () => {
        order.push('limit');
        return Promise.resolve(0);
      },
    };
    const fetchImpl = vi.fn().mockImplementation(() => {
      order.push('fetch');
      return Promise.resolve(fakeResponse({ json: [place()] }));
    });

    await geocodeSearch('astoria', {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      limiter,
    });
    expect(order).toEqual(['limit', 'fetch']);
  });
});
