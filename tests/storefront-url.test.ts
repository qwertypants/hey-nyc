import { describe, expect, it } from 'vitest';
import { parseUrlState, serializeUrlState } from '../src/lib/urlState';
import { AREA_ID, REPORT_ID } from './storefront-fixtures';
describe('storefront shared links', () => {
  it('roundtrips source reporting labels, tri-state construction, status and selected reports', () => {
    const raw = `?mode=storefronts&year=2019+and+2020&status=both&construction=unknown&borough=Queens&sel=${REPORT_ID}`;
    const parsed = parseUrlState(raw);
    expect(parsed.filters).toMatchObject({ year: '2019 and 2020', status: 'both', construction: 'unknown', borough: 'Queens' });
    const canonical = serializeUrlState(parsed);
    expect(serializeUrlState(parseUrlState(canonical))).toBe(canonical);
    expect(parseUrlState(canonical).selectedId).toBe(REPORT_ID);
  });
  it('omits defaults and preserves selected areas and literal unknown year for explicit error handling', () => {
    expect(serializeUrlState(parseUrlState('?mode=storefronts&year=2024&status=vacant&construction=any'))).toBe('?mode=storefronts');
    expect(parseUrlState(`?mode=storefronts&sel=${AREA_ID}`).selectedId).toBe(AREA_ID);
    expect(parseUrlState('?mode=storefronts&year=2026').filters.year).toBe('2026');
  });
  it('rejects unsafe labels and mode-incompatible selections', () => {
    expect(parseUrlState(`?mode=eat&sel=${REPORT_ID}`).selectedId).toBeNull();
    expect(parseUrlState('?mode=storefronts&sel=eoy-0123456789ab').selectedId).toBeNull();
    expect(parseUrlState('?mode=storefronts&year=../../2024&construction=false&status=active').filters).toMatchObject({ year: '2024', construction: 'any', status: 'vacant' });
    expect(parseUrlState('?mode=walk&sel=wsh-0123456789ab').selectedId).toBe('wsh-0123456789ab');
  });
  it('never leaks storefront-only parameters into other modes', () => {
    const state = parseUrlState('?mode=storefronts&year=2025&status=both&construction=unknown');
    expect(serializeUrlState({ ...state, mode: 'eat' })).toBe('');
    expect(serializeUrlState({ ...state, mode: 'walk' })).toBe('?mode=walk');
  });
});
