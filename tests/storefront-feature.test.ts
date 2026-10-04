import { describe, expect, it, vi } from 'vitest';
import { createStorefrontFeature } from '../src/features/storefronts/feature';
import { DEFAULT_STOREFRONT_FILTERS, matchesConstruction, normalizeStorefrontFilters, summarizeArea } from '../src/features/storefronts/filters';
import { storefrontSourceAge } from '../src/features/storefronts/provenance';
import { areaDetail, reportDetail } from '../src/features/storefronts/detail';
import { storefrontMapData, STOREFRONT_LAYER_IDS } from '../src/features/storefronts/layers';
import { createFakeMap, clusterFeature } from './helpers/fakeMap';
import { AREA_ID, REPORT_ID, SF_AREA, SF_REPORT, SF_UNKNOWN_AREA, sfArtifacts } from './storefront-fixtures';
const query = { filters: DEFAULT_STOREFRONT_FILTERS, bounds: null, origin: null, sort: null, limit: 60 };
function feature() { return createStorefrontFeature(sfArtifacts(), 'ready', null, vi.fn()); }
describe('storefront summaries and qualified details', () => {
  it('keeps unknown construction distinct from reported no', () => {
    expect(matchesConstruction(null, 'notReported')).toBe(false);
    expect(matchesConstruction(null, 'unknown')).toBe(true);
    expect(matchesConstruction(false, 'notReported')).toBe(true);
    expect(normalizeStorefrontFilters({ construction: 'NO', year: 'latest', status: 'active' })).toEqual(DEFAULT_STOREFRONT_FILTERS);
  });
  it('calculates source freshness from source metadata rather than retrieval/build time', () => {
    expect(storefrontSourceAge('2026-04-09T14:31:46Z', Date.parse('2026-10-03T17:00:00Z'))).toBe('Source updated Apr 9, 2026 · 177 days old');
  });
  it('includes all source records, unmapped and unknowns in its denominator', () => {
    expect(summarizeArea(SF_UNKNOWN_AREA)).toMatchObject({ total: 2, vacant: 1, nonVacant: 1, mappable: 1, constructionUnknown: 1 });
    expect(summarizeArea(SF_AREA, 'unknown')).toMatchObject({ total: 1, vacant: 0, unknown: 1 });
    const detail = areaDetail(SF_AREA, sfArtifacts(), 'any');
    expect(detail.facts.find((f) => f.label === 'Reported vacancy share')?.value).toBe('25.0% (1 / 4)');
    expect(detail.facts.find((f) => f.label === 'Unknown December status')?.value).toBe('1');
  });
  it('suppresses share for vacancy-only reporting coverage', () => {
    const loaded = sfArtifacts('2025'); const area = loaded.areas.areas[0];
    if (!area) throw new Error('fixture area absent');
    expect(areaDetail(area, loaded, 'any').facts.find((f) => f.label === 'Reported vacancy share')?.value).toContain('Unavailable');
  });
  it('never calls missing follow-up or construction false, activity previous business, or date availability', () => {
    const detail = reportDetail({ ...SF_REPORT, construction: null, businessActivity: null });
    expect(detail.facts.find((f) => f.label === 'Construction')?.value).toBe('Unknown / not reported');
    expect(detail.facts.find((f) => f.label === 'June / date sold status')?.value).toBe('Not reported');
    expect(detail.facts.find((f) => f.label === 'Raw reported business activity')?.value).toBe('Not reported');
    expect(detail.facts.some((f) => /previous|available/i.test(f.label))).toBe(false);
    expect(detail.caveat).toMatch(/do not establish availability/);
    expect(detail.caveat).toMatch(/not a uniquely identified storefront/);
  });
});
describe('feature scale, status and lifecycle', () => {
  it('offers area summaries at city/neighborhood scale and individual vacant reports at street scale', () => {
    const f = feature();
    expect(f.rows({ ...query, zoom: 10 }).rows.map((r) => r.badge)).toEqual(['AREA SUMMARY', 'AREA SUMMARY']);
    expect(f.rows({ ...query, zoom: 14 }).rows[0]?.badge).toBe('AREA SUMMARY');
    expect(f.rows({ ...query, zoom: 15 }).rows.every((r) => r.badge === 'REPORTED VACANT')).toBe(true);
    expect(f.rows({ ...query, zoom: 15, filters: { ...query.filters, status: 'nonVacant' } }).rows.every((r) => r.badge === 'AREA SUMMARY')).toBe(true);
    expect(f.rows({ ...query, zoom: 15, filters: { ...query.filters, status: 'both' } }).rows.every((r) => r.badge === 'AREA SUMMARY')).toBe(true);
  });
  it('filters cohort, construction and borough identically in map data and list', () => {
    const loaded = sfArtifacts(); const f = feature();
    const filters = { ...DEFAULT_STOREFRONT_FILTERS, construction: 'unknown' as const };
    expect(storefrontMapData(loaded, filters).vacant.features).toHaveLength(1);
    expect(f.rows({ ...query, filters, zoom: 15 }).total).toBe(1);
    expect(f.rows({ ...query, filters: { ...filters, borough: 'Queens' }, zoom: 15 }).total).toBe(0);
    expect(f.rows({ ...query, filters: { ...filters, year: '2025' }, zoom: 15 }).total).toBe(0);
    expect(storefrontMapData(loaded, { ...filters, status: 'nonVacant' }).vacant.features).toHaveLength(0);
  });
  it('includes unmapped area rows and resolves their summary without a fake camera position', () => {
    const f = feature();
    expect(f.detail(SF_UNKNOWN_AREA.id)?.title).toBe('Unknown geography');
    expect(f.positionOf(SF_UNKNOWN_AREA.id)).toBeNull();
    expect(f.rows(query).rows.find((r) => r.id === SF_UNKNOWN_AREA.id)?.meta).toContain('no mapped center');
  });
  it('matches source uppercase boroughs without rewriting their raw reported value', () => {
    const loaded = sfArtifacts();
    loaded.areas.areas[0] = { ...SF_AREA, borough: 'MANHATTAN' };
    loaded.vacant.features[0] = { ...loaded.vacant.features[0], type: 'Feature', id: REPORT_ID, geometry: { type: 'Point', coordinates: [-73.98, 40.75] }, properties: { ...SF_REPORT, borough: 'MANHATTAN' } };
    const f = createStorefrontFeature(loaded, 'ready', null, vi.fn());
    const filters = { ...DEFAULT_STOREFRONT_FILTERS, borough: 'Manhattan' as const };
    expect(f.rows({ ...query, filters, zoom: 15 }).total).toBe(2);
    expect(storefrontMapData(loaded, filters).vacant.features).toHaveLength(2);
    expect(loaded.vacant.features[0].properties.borough).toBe('MANHATTAN');
  });
  it('retains source borough subgroups sharing one polygon instead of overwriting their counts', () => {
    const loaded = sfArtifacts();
    loaded.areas.areas.push({ ...SF_AREA, id: `area-${'1'.repeat(24)}`, borough: 'BRONX' });
    const data = storefrontMapData(loaded, DEFAULT_STOREFRONT_FILTERS);
    expect(data.boundaries.features).toHaveLength(2);
    expect(data.boundaries.features.reduce((n, f) => n + f.properties.records, 0)).toBe(2);
    expect(data.labels.features[0]?.properties.offset).not.toEqual(data.labels.features[1]?.properties.offset);
    expect(areaDetail(SF_AREA, loaded, 'any').facts.some((f) => f.label === 'Other source borough group: BRONX')).toBe(true);
    expect(storefrontMapData(loaded, { ...DEFAULT_STOREFRONT_FILTERS, status: 'both' }).vacant.features).toHaveLength(0);
  });
  it('supports historical source labels without inventing a replacement polygon', () => {
    const loaded = sfArtifacts(); loaded.areas.areas[0] = { ...SF_AREA, ntaVintage: '2010', nta: 'MN01', boundaryId: null };
    const data = storefrontMapData(loaded, DEFAULT_STOREFRONT_FILTERS);
    expect(data.boundaries.features).toHaveLength(0); expect(data.labels.features).toHaveLength(1);
  });
  it('mounts idempotently and removes every layer, source and listener on repeated teardown', () => {
    const fake = createFakeMap(); const f = feature();
    f.mount(fake.map); const count = fake.listenerCount(); f.mount(fake.map);
    expect(fake.layerIds()).toEqual([...STOREFRONT_LAYER_IDS]); expect(fake.listenerCount()).toBe(count);
    expect(fake.easeToCalls).toHaveLength(0);
    f.unmount(fake.map); f.unmount(fake.map);
    expect(fake.layerIds()).toEqual([]); expect(fake.sourceIds()).toEqual([]); expect(fake.listenerCount()).toBe(0);
  });
  it('reports scoped point and area selections and clears a selection hidden by filters', () => {
    const fake = createFakeMap(); const f = feature(); const handlers = { onSelect: vi.fn(), onClearSelection: vi.fn(), onError: vi.fn() };
    f.state.setHandlers(handlers); f.mount(fake.map);
    fake.setRenderedFeatures([{ properties: { id: REPORT_ID } }]); fake.fire('click', { point: [0, 0] });
    expect(handlers.onSelect).toHaveBeenCalledWith(REPORT_ID);
    expect(fake.queries()[0]?.options).toMatchObject({ layers: expect.arrayContaining(['sf-points', 'sf-area-fill']) });
    f.state.setSelectedId(REPORT_ID); f.state.setFilters({ ...DEFAULT_STOREFRONT_FILTERS, status: 'nonVacant' });
    expect(handlers.onClearSelection).toHaveBeenCalledOnce(); expect(f.detail(REPORT_ID)).toBeNull();
    expect(f.detail(AREA_ID)).not.toBeNull();
  });
  it('expands a cluster using its own index, but cancels camera work after unmount', async () => {
    const fake = createFakeMap(); const f = feature(); f.mount(fake.map);
    fake.setRenderedFeatures([clusterFeature(1, [-73.98, 40.75])]); fake.fire('click', { point: [0, 0] }); await Promise.resolve();
    expect(fake.easeToCalls[0]).toMatchObject({ zoom: 14, center: [-73.98, 40.75] });
    fake.fire('click', { point: [0, 0] }); f.unmount(fake.map); await Promise.resolve(); expect(fake.easeToCalls).toHaveLength(1);
  });
});
