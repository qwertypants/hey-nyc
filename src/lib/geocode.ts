/**
 * INTEGRATION NOTES (src/lib/geocode.ts)
 *
 * Place search via the public Nominatim instance. This is the ONLY outbound request the
 * app makes, and it is deliberately hard to abuse:
 *
 * - It fires ONLY from an explicit submit (Enter / "Search" button). There is no
 *   keystroke-driven autocomplete path here, because Nominatim's usage policy forbids
 *   against the public endpoint.
 * - At most one request per second, enforced by a timestamp guard in `createRateLimiter`,
 *   shared process-wide by the default limiter.
 * - `format=jsonv2`, `limit=5`, `countrycodes=us` and an NYC viewbox bias.
 * - The app identifies itself through the `email` parameter, which browsers cannot be
 *   prevented from leaking; the Referer is sent automatically. Both come from
 *   `GEOCODER_CONTACT` / `VITE_GEOCODER_CONTACT`.
 * - A 429 is reported as `status: 'rate-limited'` and is never retried. There is no retry
 *   logic at all: the user can press Search again.
 * - Bounded timeout, and a caller-supplied `AbortSignal` is honoured.
 *
 * Public surface:
 *   NOMINATIM_ENDPOINT, NYC_VIEWBOX, NYC_FOCUS, GEOCODER_CONTACT, MIN_REQUEST_INTERVAL_MS,
 *   type GeocodeResult, type GeocodeStatus, type GeocodeOutcome, type RateLimiter,
 *   type GeocodeOptions
 *   createRateLimiter(options?): RateLimiter
 *   defaultRateLimiter
 *   geocodeSearch(query, options?): Promise<GeocodeOutcome>
 *
 * Everything injectable (`endpoint`, `fetchImpl`, `now`, `limiter`, `timeoutMs`) exists so
 * `tests/lib-geocode.test.ts` can exercise the rate limiter and the 429 path with a mocked
 * fetch and a controlled clock, hitting no network.
 */

export const NOMINATIM_ENDPOINT = 'https://nominatim.openstreetmap.org/search';

/** Nominatim `viewbox` bias: west, north, east, south. Covers the five boroughs. */
export const NYC_VIEWBOX = '-74.30, 41.00, -73.65, 40.40';

/** `bounded` so a loose query cannot drag results in from New Jersey. */
export const NYC_FOCUS = 1;

export const RESULT_LIMIT = 5;

/** Nominatim's absolute floor. `createRateLimiter` will not go below it. */
export const MIN_REQUEST_INTERVAL_MS = 1000;

export const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Identification for Nominatim's usage policy. A fork should override it:
 *   VITE_GEOCODER_CONTACT=you@example.com
 * The placeholder keeps requests working but is not a working address.
 */
export const GEOCODER_CONTACT =
  (typeof import.meta !== 'undefined' &&
    typeof import.meta.env?.VITE_GEOCODER_CONTACT === 'string'
    ? import.meta.env.VITE_GEOCODER_CONTACT
    : '') || 'eat-outside-nyc@users.noreply.github.com';

export interface GeocodeResult {
  readonly placeId: string;
  readonly label: string;
  readonly lat: number;
  readonly lng: number;
  /** Nominatim's `type`/`class` collapsed to one word, e.g. "restaurant". May be ''. */
  readonly kind: string;
  /** Nominatim's 0..1 relevance score, used to keep the response order stable. */
  readonly importance: number;
}

export type GeocodeStatus =
  | 'ok'
  | 'empty'
  | 'invalid-query'
  | 'rate-limited'
  | 'timeout'
  | 'offline'
  | 'error';

export type GeocodeOutcome =
  | { readonly status: 'ok'; readonly results: readonly GeocodeResult[] }
  | { readonly status: 'empty'; readonly query: string }
  | { readonly status: 'invalid-query'; readonly query: string }
  | { readonly status: 'rate-limited'; readonly query: string; readonly retryAfterMs: number }
  | { readonly status: 'timeout'; readonly query: string }
  | { readonly status: 'offline'; readonly query: string }
  | { readonly status: 'error'; readonly query: string; readonly message: string };

export interface RateLimiter {
  /** Resolves once the caller may issue a request; resolves with the ms actually waited. */
  wait(): Promise<number>;
}

export interface RateLimiterOptions {
  /** Defaults to `MIN_REQUEST_INTERVAL_MS` and is clamped to at least that value. */
  readonly minIntervalMs?: number;
  /** Injectable clock. Tests drive this directly instead of sleeping. */
  readonly now?: () => number;
  /** Injectable sleep. Defaults to `setTimeout`. */
  readonly sleep?: (ms: number) => Promise<void>;
}

/**
 * Timestamp guard. A single instance serialises every caller: each `wait()` reserves the
 * next slot rather than comparing against "now" only, so N concurrent calls queue instead
 * of all passing the check in the same millisecond.
 */
export function createRateLimiter(options: RateLimiterOptions = {}): RateLimiter {
  const now = options.now ?? (() => Date.now());
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const requested = options.minIntervalMs ?? MIN_REQUEST_INTERVAL_MS;
  const minIntervalMs = Number.isFinite(requested) ? Math.max(MIN_REQUEST_INTERVAL_MS, requested) : MIN_REQUEST_INTERVAL_MS;

  let nextSlot = 0;

  return {
    async wait(): Promise<number> {
      const requestedAt = now();
      const slot = Math.max(requestedAt, nextSlot);
      nextSlot = slot + minIntervalMs;
      const waitMs = slot - requestedAt;
      if (waitMs > 0) await sleep(waitMs);
      return waitMs;
    },
  };
}

/**
 * Process-wide guard. Created lazily so importing this module in a test never pins a
 * clock, and exposed so a test can swap in a fake limiter.
 */
export const defaultRateLimiter: RateLimiter = createRateLimiter();

export interface GeocodeOptions {
  readonly signal?: AbortSignal;
  readonly endpoint?: string;
  readonly fetchImpl?: typeof fetch;
  readonly limiter?: RateLimiter;
  readonly timeoutMs?: number;
  readonly contact?: string;
  /** Escape hatch for tests that need the built URL. Defaults to the real endpoint. */
  readonly buildUrl?: (query: string, endpoint: string) => string;
}

function buildSearchUrl(query: string, endpoint: string, contact: string): string {
  const params = new URLSearchParams({
    q: query,
    format: 'jsonv2',
    limit: String(RESULT_LIMIT),
    addressdetails: '0',
    countrycodes: 'us',
    viewbox: NYC_VIEWBOX,
    bounded: String(NYC_FOCUS),
  });
  if (contact.length > 0) params.set('email', contact);
  return `${endpoint}?${params.toString()}`;
}

interface NominatimPlace {
  place_id?: unknown;
  display_name?: unknown;
  lat?: unknown;
  lon?: unknown;
  addresstype?: unknown;
  type?: unknown;
  importance?: unknown;
  class?: unknown;
}

function toResult(place: NominatimPlace, index: number): GeocodeResult | null {
  if (typeof place !== 'object' || place === null) return null;
  const lat = Number(place.lat);
  const lng = Number(place.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  const label = typeof place.display_name === 'string' ? place.display_name.trim() : '';
  if (label.length === 0) return null;

  const kindParts = [place.type, place.addresstype, place.class].filter(
    (value): value is string => typeof value === 'string' && value.length > 0,
  );

  return {
    placeId:
      typeof place.place_id === 'number' || typeof place.place_id === 'string'
        ? String(place.place_id)
        : `nominatim-${index}`,
    label,
    lat,
    lng,
    kind: kindParts[0] ?? '',
    importance: Number.isFinite(Number(place.importance)) ? Number(place.importance) : 0,
  };
}

function parseRetryAfterMs(response: Response): number {
  const header = response.headers?.get?.('Retry-After');
  if (typeof header === 'string') {
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000);
  }
  return MIN_REQUEST_INTERVAL_MS;
}

/**
 * One search. Never throws and never retries: every failure mode is a distinct `status`
 * the UI can show verbatim.
 */
export async function geocodeSearch(
  query: string,
  options: GeocodeOptions = {},
): Promise<GeocodeOutcome> {
  const trimmed = typeof query === 'string' ? query.trim() : '';
  if (trimmed.length === 0) return { status: 'invalid-query', query: trimmed };
  if (trimmed.length > 200) return { status: 'invalid-query', query: trimmed };

  const endpoint = options.endpoint ?? NOMINATIM_ENDPOINT;
  const doFetch = options.fetchImpl ?? (typeof fetch === 'function' ? fetch : undefined);
  if (doFetch === undefined) return { status: 'error', query: trimmed, message: 'fetch unavailable' };

  if (isAborted(options)) return { status: 'error', query: trimmed, message: 'Aborted' };

  const limiter = options.limiter ?? defaultRateLimiter;
  await limiter.wait();

  // The rate-limit wait is not abortable, so the signal can fire during it.
  if (isAborted(options)) return { status: 'error', query: trimmed, message: 'Aborted' };

  const requestedTimeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const timeoutMs = Number.isFinite(requestedTimeout) ? Math.max(0, requestedTimeout) : DEFAULT_TIMEOUT_MS;

  const controller = new AbortController();
  let timedOut = false;
  const timer =
    timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true;
          controller.abort();
        }, timeoutMs)
      : null;

  const onExternalAbort = (): void => controller.abort();
  options.signal?.addEventListener('abort', onExternalAbort, { once: true });

  const contact = options.contact ?? GEOCODER_CONTACT;
  const url = (options.buildUrl ?? buildSearchUrl)(trimmed, endpoint, contact);

  try {
    const response = await doFetch(url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: controller.signal,
      // Nominatim's caching proxies behave better with an explicit policy.
      cache: 'no-store',
    });

    if (response.status === 429 || response.status === 503) {
      return { status: 'rate-limited', query: trimmed, retryAfterMs: parseRetryAfterMs(response) };
    }
    if (!response.ok) {
      return {
        status: 'error',
        query: trimmed,
        message: `Nominatim responded ${response.status}`,
      };
    }

    const payload: unknown = await response.json();
    if (!Array.isArray(payload)) {
      return { status: 'error', query: trimmed, message: 'Nominatim returned a non-array payload' };
    }

    const results = payload
      .slice(0, RESULT_LIMIT)
      .map((place, index) => toResult(place as NominatimPlace, index))
      .filter((result): result is GeocodeResult => result !== null);

    return results.length === 0 ? { status: 'empty', query: trimmed } : { status: 'ok', results };
  } catch (error) {
    if (timedOut) return { status: 'timeout', query: trimmed };
    if (isAbortError(error)) return { status: 'error', query: trimmed, message: 'Search cancelled' };
    if (error instanceof TypeError) {
      return { status: 'offline', query: trimmed };
    }
    return {
      status: 'error',
      query: trimmed,
      message: error instanceof Error ? error.message : 'Search failed',
    };
  } finally {
    if (timer !== null) clearTimeout(timer);
    options.signal?.removeEventListener('abort', onExternalAbort);
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

/**
 * Read through a function so the check is re-evaluated after every `await`: TypeScript
 * would otherwise keep the narrowing from an earlier `options.signal?.aborted === true`.
 */
function isAborted(options: GeocodeOptions): boolean {
  return options.signal !== undefined && options.signal.aborted;
}
