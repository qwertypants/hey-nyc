import { describe, expect, it } from 'vitest';
import {
  DEFAULT_VIEW,
  MAX_ZOOM,
  MIN_ZOOM,
  clampView,
  isValidLocationId,
  parseUrlState,
  roundView,
  sameView,
  serializeUrlState,
  urlStateWithFilters,
  urlStateWithView,
} from '../src/lib/urlState';
import type { MapView, UrlState } from '../src/lib/urlState';

const VIEW: MapView = { lat: 40.7306, lng: -73.9866, zoom: 14.25 };
const ID = 'eoy-3f2a1b9c4d5e';

function queryOf(state: UrlState): string {
  return serializeUrlState(state);
}

describe('parseUrlState / serializeUrlState round trip', () => {
  it('round-trips every field', () => {
    const state: UrlState = {
      view: VIEW,
      filters: { type: 'roadway', borough: 'Staten Island' },
      selectedId: ID,
    };
    const first = serializeUrlState(state);
    expect(first).toBe(
      '?lat=40.7306&lng=-73.9866&z=14.25&type=roadway&borough=Staten+Island&sel=eoy-3f2a1b9c4d5e',
    );
    expect(parseUrlState(first)).toEqual(state);
  });

  it('is idempotent: serialising a parsed value changes nothing', () => {
    const search = '?lat=40.7&lng=-73.9&z=12&type=both&borough=Bronx&sel=eoy-abcdef012345';
    const once = serializeUrlState(parseUrlState(search));
    const twice = serializeUrlState(parseUrlState(once));
    expect(once).toBe(search);
    expect(twice).toBe(once);
  });

  it('omits defaults so the shared link stays short', () => {
    expect(serializeUrlState(parseUrlState(''))).toBe('');
    expect(serializeUrlState({ view: DEFAULT_VIEW, filters: { type: 'all', borough: 'all' }, selectedId: null })).toBe('');
  });

  it('emits the keys in a fixed order', () => {
    const keys = serializeUrlState({
      view: VIEW,
      filters: { type: 'sidewalk', borough: 'Queens' },
      selectedId: ID,
    })
      .slice(1)
      .split('&')
      .map((pair) => pair.split('=')[0]);
    expect(keys).toEqual(['lat', 'lng', 'z', 'type', 'borough', 'sel']);
  });

  it('never writes a key outside the whitelist, so no geolocation can leak into a link', () => {
    const hostile = {
      view: VIEW,
      filters: { type: 'sidewalk', borough: 'Manhattan', origin: { lat: 40.7, lng: -73.9 } },
      selectedId: ID,
      userLocation: { lat: 40.7128, lng: -74.006 },
    } as unknown as UrlState;
    const query = serializeUrlState(hostile);
    expect(query).not.toContain('origin');
    expect(query).not.toContain('userLocation');
    expect(query).toBe(
      '?lat=40.7306&lng=-73.9866&z=14.25&type=sidewalk&borough=Manhattan&sel=eoy-3f2a1b9c4d5e',
    );
  });

  it('accepts a search string with or without the leading question mark', () => {
    expect(parseUrlState('lat=40.5&lng=-74&z=10')).toEqual(parseUrlState('?lat=40.5&lng=-74&z=10'));
  });
});

describe('coordinate and zoom normalisation', () => {
  it('rounds coordinates to 5dp and zoom to 2dp so shared links are stable', () => {
    const parsed = parseUrlState('?lat=40.730612345&lng=-73.98659876&z=14.256789');
    expect(parsed.view).toEqual({ lat: 40.73061, lng: -73.9866, zoom: 14.26 });
  });

  it('drops a trailing zero rather than writing 14.20', () => {
    expect(parseUrlState('?z=14.20').view.zoom).toBe(14.2);
    expect(serializeUrlState(parseUrlState('?z=14.20'))).toMatch(/[?&]z=14\.2(&|$)/);
  });

  it('clamps zoom into the camera range', () => {
    expect(parseUrlState('?z=99999').view.zoom).toBe(MAX_ZOOM);
    expect(parseUrlState('?z=-500').view.zoom).toBe(MIN_ZOOM);
  });

  it('clamps coordinates into the NYC view limits', () => {
    expect(parseUrlState('?lat=95&lng=200').view).toEqual({
      lat: 41.1,
      lng: -73.65,
      zoom: DEFAULT_VIEW.zoom,
    });
    expect(parseUrlState('?lat=-95&lng=-200').view).toEqual({
      lat: 40.35,
      lng: -74.35,
      zoom: DEFAULT_VIEW.zoom,
    });
  });

  it('clamps anything an out-of-range camera would reject', () => {
    const clamped = clampView({ lat: 900, lng: 900, zoom: 900 });
    expect(clamped).toEqual({ lat: 41.1, lng: -73.65, zoom: MAX_ZOOM });
  });

  it('roundView and sameView are exact, not approximate', () => {
    const a = roundView({ lat: 40.700000049, lng: -73.900000049, zoom: 12.001 });
    expect(a).toEqual({ lat: 40.7, lng: -73.9, zoom: 12 });
    expect(sameView(a, { lat: 40.7, lng: -73.9, zoom: 12 })).toBe(true);
  });
});

describe('malformed, hostile and absurd input falls back safely', () => {
  const cases: Array<[string, string]> = [
    ['NaN literal', '?lat=NaN&lng=NaN&z=NaN'],
    ['Infinity literal', '?lat=Infinity&lng=-Infinity&z=Infinity'],
    ['exponent overflow', '?lat=1e999&z=-1e999'],
    ['not a number', '?lat=forty&lng=west&z=close'],
    ['empty values', '?lat=&lng=&z='],
    ['whitespace values', '?lat=%20%20&lng=%20&z=%20'],
    ['array-ish injection', '?lat[]=1&lng[]=2'],
    ['script tag', '?type=<script>alert(1)</script>'],
    ['unknown type', '?type=patio'],
    ['unknown borough', '?borough=New%20Jersey'],
    ['wrong case borough', '?borough=brooklyn'],
    ['negative numbers', '?lat=-40.7&lng=73.9&z=-14'],
    ['huge zoom', '?z=99999'],
    ['huge string', `?lat=${'9'.repeat(5000)}`],
    ['duplicate keys', '?lat=40.1&lat=41.9&z=10&z=15&type=both&type=sidewalk'],
    ['prototype pollution attempt', '?borough=__proto__&type=constructor'],
    ['percent-encoded junk', '?%zz=&lat=%E0%A4%A'],
    ['sel with markup', '?sel=<script>alert(1)</script>'],
    ['sel wrong shape', '?sel=not-an-id'],
    ['sel wrong hex case', '?sel=eoy-ABCDEF012345'],
    ['sel too long', `?sel=${'eoy-'.repeat(40)}`],
    ['null byte', '?type=sidewalk%00roadway'],
  ];

  for (const [label, search] of cases) {
    it(`never throws and never leaves the safe envelope: ${label}`, () => {
      const parsed = parseUrlState(search);
      expect(Number.isFinite(parsed.view.lat)).toBe(true);
      expect(Number.isFinite(parsed.view.lng)).toBe(true);
      expect(Number.isFinite(parsed.view.zoom)).toBe(true);
      expect(parsed.view.lat).toBeGreaterThanOrEqual(40.35);
      expect(parsed.view.lat).toBeLessThanOrEqual(41.1);
      expect(parsed.view.lng).toBeGreaterThanOrEqual(-74.35);
      expect(parsed.view.lng).toBeLessThanOrEqual(-73.65);
      expect(parsed.view.zoom).toBeGreaterThanOrEqual(MIN_ZOOM);
      expect(parsed.view.zoom).toBeLessThanOrEqual(MAX_ZOOM);
      expect(['all', 'sidewalk', 'roadway', 'both']).toContain(parsed.filters.type);
      expect(['all', 'Manhattan', 'Brooklyn', 'Queens', 'Bronx', 'Staten Island']).toContain(
        parsed.filters.borough,
      );
      expect(parsed.selectedId === null || isValidLocationId(parsed.selectedId)).toBe(true);
    });
  }

  it('does not throw on non-string input', () => {
    for (const input of [undefined, null, 42, {}, [], true]) {
      expect(() => parseUrlState(input as unknown as string)).not.toThrow();
      expect(parseUrlState(input as unknown as string).view).toEqual(DEFAULT_VIEW);
    }
  });

  it('does not throw when serialising garbage state', () => {
    expect(() =>
      serializeUrlState({
        view: null as unknown as MapView,
        filters: null as unknown as UrlState['filters'],
        selectedId: 99 as unknown as string,
      }),
    ).not.toThrow();
    expect(
      serializeUrlState({
        view: null as unknown as MapView,
        filters: { type: 'nope' as never, borough: 'nope' as never },
        selectedId: null,
      }),
    ).toBe('');
  });

  it('resolves duplicate keys to the first occurrence, like URLSearchParams', () => {
    expect(parseUrlState('?lat=40.6&lat=41.0').view.lat).toBe(40.6);
    expect(parseUrlState('?z=10&z=15').view.zoom).toBe(10);
    expect(parseUrlState('?type=both&type=sidewalk').filters.type).toBe('both');
  });

  it('discards an over-long value rather than parsing it', () => {
    const hostile = `?lat=${'4'.repeat(80)}&z=13.5`;
    const parsed = parseUrlState(hostile);
    expect(parsed.view.lat).toBe(DEFAULT_VIEW.lat);
    expect(parsed.view.zoom).toBe(13.5);
  });
});

describe('selection and filter parsing', () => {
  it('accepts only the contract id shape', () => {
    expect(isValidLocationId('eoy-0123456789ab')).toBe(true);
    expect(isValidLocationId('eoy-0123456789AB')).toBe(false);
    expect(isValidLocationId('eoy-0123456789a')).toBe(false);
    expect(isValidLocationId('eoy-0123456789abc')).toBe(false);
    expect(isValidLocationId('eoy-0123456789ag')).toBe(false);
    expect(isValidLocationId('eoy-')).toBe(false);
    expect(isValidLocationId('')).toBe(false);
    expect(isValidLocationId(null)).toBe(false);
  });

  it('keeps a well-formed id that is not in the dataset (the UI drops it, not the parser)', () => {
    expect(parseUrlState('?sel=eoy-ffffffffffff').selectedId).toBe('eoy-ffffffffffff');
  });

  it('drops a hostile sel', () => {
    expect(parseUrlState('?sel=eoy-../etc/passwd').selectedId).toBeNull();
    expect(parseUrlState('?sel=javascript:alert(1)').selectedId).toBeNull();
  });

  it('preserves filters and selection through the helper constructors', () => {
    const base = parseUrlState('?type=roadway&borough=Bronx&sel=eoy-0123456789ab');
    const withFilters = urlStateWithFilters(base, { type: 'both', borough: 'all' });
    expect(queryOf(withFilters)).toBe('?type=both&sel=eoy-0123456789ab');
    const withView = urlStateWithView(withFilters, VIEW);
    expect(queryOf(withView)).toContain('lat=40.7306');
    expect(withView.filters).toEqual({ type: 'both', borough: 'all' });
    expect(withView.selectedId).toBe('eoy-0123456789ab');
  });
});
