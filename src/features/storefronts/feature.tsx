import type { Filters } from '../../lib/filters';
import { boundsContain } from '../../lib/bounds';
import type { AnyFeature, FeatureData, FeatureHandlers, FeatureRow, MapLibreLike } from '../registry';
import type { StorefrontArea, StorefrontProperties, StorefrontMetadata } from '../../types/storefronts';
import type { LoadedStorefronts } from './load';
import { DEFAULT_STOREFRONT_FILTERS, matchesArea, matchesReport, normalizeStorefrontFilters, summarizeArea } from './filters';
import { areaDetail, reportDetail } from './detail';
import { mountStorefrontLayers, removeStorefrontLayers } from './layers';
import { methodologyHref, StorefrontFiltersControl, StorefrontSearch, StorefrontSheet } from './Controls';
export const STOREFRONT_IDENTITY = { id: 'storefronts', label: 'Storefront Pulse', description: 'Owner-reported storefront records, with reporting coverage and unknowns.', attribution: 'NYC Department of Finance · Storefronts Reported Vacant or Not (92iy-9c3n)' } as const;
export type StorefrontItem = StorefrontArea | StorefrontProperties;
const emptyItems: StorefrontItem[] = [];
const emptyMap: ReadonlyMap<string, StorefrontItem> = new Map();
export function createStorefrontFeature(loaded: LoadedStorefronts | null, status: FeatureData<StorefrontItem>['status'], error: Error | null, retry: () => void, metadata: StorefrontMetadata | null = loaded?.metadata ?? null): AnyFeature {
  const reports = loaded?.vacant.features ?? [];
  const areas = loaded?.areas.areas ?? [];
  const byId: ReadonlyMap<string, StorefrontItem> = loaded === null ? emptyMap : new Map<string, StorefrontItem>([...areas.map((a) => [a.id, a] as const), ...reports.map((f) => [f.id, f.properties] as const)]);
  const pointCoords = new Map(reports.map((f) => [f.id, f.geometry.coordinates]));
  let filters = { ...DEFAULT_STOREFRONT_FILTERS, year: loaded?.areas.areas[0]?.reportingYear ?? '2024' };
  let selected: string | null = null;
  let handle: ReturnType<typeof mountStorefrontLayers> | null = null;
  let handlers: FeatureHandlers | null = null;
  function areaCount(area: StorefrontArea, f = filters): number { const s = summarizeArea(area, f.construction); return f.status === 'both' ? s.total : s[f.status]; }
  function detail(id: string) {
    const item = byId.get(id);
    if (!item || !loaded) return null;
    if ('totalRecords' in item) return matchesArea(item, filters) && areaCount(item) > 0 ? areaDetail(item, loaded, filters.construction) : null;
    return matchesReport(item, filters) ? reportDetail(item) : null;
  }
  return {
    identity: STOREFRONT_IDENTITY,
    data: { status, items: loaded ? [...areas, ...reports.map((f) => f.properties)] : emptyItems, byId, error, retry, provenance: loaded ? `DOF source updated ${loaded.metadata.source.updatedAt} · reporting labels preserved` : null },
    state: {
      setFilters(next: Filters) { filters = normalizeStorefrontFilters(next); handle?.setFilters(filters); if (selected !== null && detail(selected) === null) { selected = null; handle?.setSelectedId(null); handlers?.onClearSelection(); } },
      setSelectedId(id) { selected = id; handle?.setSelectedId(id); },
      setHandlers(next) { handlers = next; },
    },
    mount(map: MapLibreLike) { if (handle !== null) { handle.setFilters(filters); handle.setSelectedId(selected); return; } if (loaded !== null) { handle = mountStorefrontLayers(map, loaded, filters, () => handlers); handle.setSelectedId(selected); } },
    unmount(map) { handle?.destroy(); handle = null; removeStorefrontLayers(map); },
    onEnter() {},
    legend: { title: 'Reported storefront records', swatches: [{ id: 'reported-vacant', label: 'Reported vacant', color: '#a95231', symbol: 'Solid circle; numbered circles group overlapping reports' }], note: 'Areas show reported-record counts; zoom in for vacant reports. Reports can repeat and are not current availability or a census of businesses.', aboutHref: methodologyHref() },
    nouns: { one: 'report or area summary', many: 'reports or area summaries' },
    copy: { mapLabel: 'Map of owner-reported storefront records in New York City', data: { loading: { title: 'Loading storefront reports', body: 'Fetching the published DOF records, summaries and official boundary coverage. Loaded once after choosing Storefront Pulse.' }, failure: { title: 'Storefront reports did not load', body: 'An empty map would imply no reported records. Retry the validated DOF artifacts.' } }, filtering: { dimensions: 'reporting period, December status, construction and borough', retryHint: 'Try a different reporting period or filter.' } },
    controls: {
      filters: (context) => <StorefrontFiltersControl {...context} loaded={loaded} metadata={metadata} />,
      search: (context) => <StorefrontSearch {...context} />,
      sort: null, legend: null,
      sheet: (context) => { const value = detail(context.id); return loaded && value ? <StorefrontSheet {...context} detail={value} loaded={loaded} /> : null; },
    },
    rows(query) {
      const f = normalizeStorefrontFilters(query.filters);
      const individual = f.status === 'vacant' && (query.zoom ?? 10) >= 15;
      let rows: FeatureRow[];
      let datasetCount: number;
      if (individual) {
        const all = reports.filter((r) => matchesReport(r.properties, f)); datasetCount = all.length;
        rows = all.filter((r) => boundsContain(query.bounds, r.geometry.coordinates[1], r.geometry.coordinates[0])).map((r) => ({ id: r.id, title: r.properties.address ?? 'Address not reported', subtitle: `${r.properties.borough ?? 'Borough unknown'} · ${r.properties.reportingYear}`, badge: 'REPORTED VACANT', meta: 'One reported record; availability unknown', symbol: 'disc', distance: null, lng: r.geometry.coordinates[0], lat: r.geometry.coordinates[1] }));
      } else {
        const all = areas.filter((a) => matchesArea(a, f) && areaCount(a, f) > 0); datasetCount = all.length;
        rows = all.filter((a) => a.center === null || boundsContain(query.bounds, a.center[1], a.center[0])).map((a) => ({ id: a.id, title: a.name ?? a.nta ?? 'Unknown geography', subtitle: `${a.borough ?? 'Borough unknown'} · ${a.reportingYear}`, badge: 'AREA SUMMARY', meta: `${areaCount(a, f).toLocaleString('en-US')} reported records${a.center === null ? ' · no mapped center' : ''}`, symbol: null, distance: null, lng: a.center?.[0] ?? Number.NaN, lat: a.center?.[1] ?? Number.NaN }));
      }
      rows.sort((a, b) => a.title.localeCompare(b.title) || a.id.localeCompare(b.id));
      return { rows: rows.slice(0, query.limit), total: rows.length, datasetCount, filtered: f.borough !== 'all' || f.year !== '2024' || f.status !== 'vacant' || f.construction !== 'any' };
    },
    extent(query) {
      const f = normalizeStorefrontFilters(query.filters);
      const positions = f.status === 'vacant' ? reports.filter((r) => matchesReport(r.properties, f)).map((r) => r.geometry.coordinates) : areas.filter((a) => matchesArea(a, f) && areaCount(a, f) > 0).flatMap((a) => a.center === null ? [] : [a.center]);
      return positions.length === 0 ? null : { west: Math.min(...positions.map((p) => p[0])), east: Math.max(...positions.map((p) => p[0])), south: Math.min(...positions.map((p) => p[1])), north: Math.max(...positions.map((p) => p[1])) };
    },
    positionOf(id) { const a = byId.get(id); const p = a && 'totalRecords' in a ? a.center : pointCoords.get(id); return p ? { lng: p[0], lat: p[1] } : null; },
    detail,
  };
}
