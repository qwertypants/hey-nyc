import { beforeEach, describe, expect, it, vi } from 'vitest';
import { validateAreas, validateBoundaries, validateMetadata, validateVacant, validateArtifacts } from '../src/features/storefronts/validate';
import { loadStorefrontsOnce, resetStorefrontCache } from '../src/features/storefronts/load';
import { SF_AREA, SF_BOUNDARIES, SF_METADATA, SF_VACANT, sfArtifacts, sfPayload } from './storefront-fixtures';
beforeEach(resetStorefrontCache);
describe('storefront artifact validation', () => {
  it('reconciles selected cohort reports without redefining global metadata totals', () => {
    expect(sfArtifacts().metadata.sourceRows).toBe(8);
    expect(sfArtifacts().areas.areas.reduce((n, a) => n + a.totalRecords, 0)).toBe(6);
    expect(sfArtifacts('2025').vacant.features).toHaveLength(1);
  });
  it.each(['../areas.json', '/areas.json', 'https://example.invalid/areas.json', 'periods/2025/../../areas.json'])('rejects unsafe manifest path %s', (areasPath) => {
    expect(() => validateMetadata({ ...SF_METADATA, periodArtifacts: [{ ...SF_METADATA.periodArtifacts[0], areasPath }, SF_METADATA.periodArtifacts[1]] })).toThrow();
  });
  it.each([
    { schemaVersion: 2 }, { sourceRows: 9 }, { contentHash: 'a' }, { defaultReportingYear: '2025' },
    { coverage: SF_METADATA.coverage.map((c) => ({ ...c, mappableRecords: 999 })) },
    { coverage: SF_METADATA.coverage.map((c) => ({ ...c, vacancyShareSupported: true })) },
    { reportingYears: ['2024', '2024'] }, { periodArtifacts: [] },
  ])('rejects malformed metadata %o', (change) => expect(() => validateMetadata({ ...SF_METADATA, ...change })).toThrow());
  it('rejects count arithmetic, duplicate cells and false-like unknown construction', () => {
    for (const counts of [[['vacant', null, 1, 2]], [['vacant', false, 4, 4], ['vacant', false, 0, 0]], [['vacant', 'false', 4, 4]], [['made-up', true, 4, 4]], [['vacant', true, 4.5, 4]]]) {
      expect(() => validateAreas({ schemaVersion: 1, areas: [{ ...SF_AREA, counts }] })).toThrow();
    }
  });
  it('refuses invented unknown geometry and mismatched boundary vintage', () => {
    for (const change of [{ nta: null, ntaVintage: null }, { boundaryId: '2010:MN0101' }, { id: 'not-an-area' }, { center: [0, 0] }]) {
      expect(() => validateAreas({ schemaVersion: 1, areas: [{ ...SF_AREA, ...change }] })).toThrow();
    }
  });
  it('rejects duplicate, malformed, occupied or non-NYC points', () => {
    const f = SF_VACANT.features[0];
    expect(() => validateVacant({ ...SF_VACANT, features: [f, f] })).toThrow();
    for (const change of [{ id: 'sf-1' }, { status: 'nonVacant' }, { construction: 'NO' }, { juneStatus: null }]) {
      expect(() => validateVacant({ ...SF_VACANT, features: [{ ...f, properties: { ...f?.properties, ...change } }] })).toThrow();
    }
    expect(() => validateVacant({ ...SF_VACANT, features: [{ ...f, geometry: { type: 'Point', coordinates: [0, 0] } }] })).toThrow();
  });
  it('requires closed authoritative polygon rings and matching source identity', () => {
    const f = SF_BOUNDARIES.features[0];
    expect(() => validateBoundaries({ ...SF_BOUNDARIES, features: [{ ...f, geometry: { type: 'Polygon', coordinates: [[[-73.99, 40.75], [-73.98, 40.75], [-73.98, 40.76], [-73.99, 40.76]]] } }] })).toThrow();
    expect(() => validateBoundaries({ ...SF_BOUNDARIES, features: [{ ...f, id: '2010:MN0101' }] })).toThrow();
  });
  it('preserves a source invalid NTA literal with unknown vintage rather than discarding its cohort', () => {
    const raw = { ...SF_AREA, nta: '0', ntaVintage: null, boundaryId: null, center: null };
    expect(validateAreas({ schemaVersion: 1, areas: [raw] }).areas[0]?.nta).toBe('0');
    const f = SF_VACANT.features[0];
    expect(validateVacant({ ...SF_VACANT, features: [{ ...f, properties: { ...f?.properties, nta: '0', ntaVintage: null } }] }).features[0]?.properties.nta).toBe('0');
  });
  it('rejects a wrong-year payload rather than showing old reports under a new label', () => {
    const good = sfArtifacts();
    expect(() => validateArtifacts(good.metadata, good.areas, good.vacant, good.boundaries, '2025')).toThrow();
  });
});
describe('lazy cohort cache', () => {
  it('fetches only the chosen cohort and shared metadata/boundaries once, including subpath deployment', async () => {
    const fetchImpl = vi.fn(async (url: RequestInfo | URL) => ({ ok: true, json: async () => sfPayload(String(url)) }) as Response);
    const options = { fetchImpl, baseUrl: '/hey-nyc/' };
    const [a, b] = await Promise.all([loadStorefrontsOnce('2024', options), loadStorefrontsOnce('2024', options)]);
    expect(a).toBe(b); expect(fetchImpl).toHaveBeenCalledTimes(4);
    expect(fetchImpl.mock.calls.every(([url]) => String(url).startsWith('/hey-nyc/data/storefronts/'))).toBe(true);
    expect(fetchImpl.mock.calls.some(([url]) => String(url).includes('/2025/'))).toBe(false);
    await loadStorefrontsOnce('2025', options); await loadStorefrontsOnce('2024', options);
    expect(fetchImpl).toHaveBeenCalledTimes(6);
  });
  it('exposes failed HTTP and malformed payloads and can retry after reset', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 503 }) as Response);
    await expect(loadStorefrontsOnce('2024', { fetchImpl })).rejects.toThrow('503');
    resetStorefrontCache();
    await expect(loadStorefrontsOnce('2024', { fetchImpl: async () => ({ ok: true, json: async () => ({}) }) as Response })).rejects.toThrow('Invalid storefront');
    resetStorefrontCache();
    await expect(loadStorefrontsOnce('2024', { fetchImpl: async (url) => ({ ok: true, json: async () => sfPayload(String(url)) }) as Response })).resolves.toHaveProperty('areas');
  });
});
