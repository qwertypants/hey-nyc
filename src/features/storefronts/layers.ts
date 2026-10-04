import type { FeatureHandlers, MapLibreLike, MapRenderedFeature, MapSubscription } from '../registry';
import type { LoadedStorefronts } from './load';
import { STOREFRONT_ATTRIBUTION_HTML, NTA_ATTRIBUTION_HTML } from './provenance';
import { matchesArea, matchesReport, summarizeArea } from './filters';
import type { StorefrontFilters } from './filters';
export const STOREFRONT_LAYER_IDS = ['sf-area-fill', 'sf-area-outline', 'sf-area-selected', 'sf-area-label', 'sf-area-fill-high', 'sf-area-outline-high', 'sf-area-label-high', 'sf-clusters', 'sf-cluster-label', 'sf-points', 'sf-point-selected'] as const;
const SOURCES = ['sf-boundaries', 'sf-labels', 'sf-vacant'] as const;
function updateSource(map: MapLibreLike, id: string, data: unknown): void {
  const source = map.getSource(id) as { setData?: (data: unknown) => void } | undefined;
  source?.setData?.(data);
}
export function removeStorefrontLayers(map: MapLibreLike): void {
  for (const id of [...STOREFRONT_LAYER_IDS].reverse()) if (map.getLayer(id)) map.removeLayer(id);
  for (const id of SOURCES) if (map.getSource(id)) map.removeSource(id);
}
export function storefrontMapData(loaded: LoadedStorefronts, filters: StorefrontFilters) {
  const areas = loaded.areas.areas.filter((a) => matchesArea(a, filters)).map((a) => {
    const counts = summarizeArea(a, filters.construction);
    const count = filters.status === 'both' ? counts.total : counts[filters.status];
    return { area: a, count };
  }).filter((a) => a.count > 0);
  const byBoundary = new Map<string, typeof areas>();
  for (const match of areas) {
    if (match.area.boundaryId === null) continue;
    const siblings = byBoundary.get(match.area.boundaryId) ?? [];
    siblings.push(match); byBoundary.set(match.area.boundaryId, siblings);
  }
  return {
    boundaries: { type: 'FeatureCollection', features: loaded.boundaries.features.flatMap((b) => {
      const match = byBoundary.get(b.id);
      return match === undefined ? [] : match.map(({ area, count }) => ({ ...b, id: area.id, properties: { ...b.properties, id: area.id, borough: area.borough, records: count } }));
    }) },
    labels: { type: 'FeatureCollection', features: areas.flatMap(({ area, count }) => area.center === null ? [] : [{
      type: 'Feature', id: area.id, geometry: { type: 'Point', coordinates: area.center },
      properties: { id: area.id, name: area.name ?? area.nta ?? 'Unknown geography', records: count, borough: area.borough ?? 'Borough unknown', offset: [0, 4 * (area.boundaryId === null ? 0 : (byBoundary.get(area.boundaryId)?.findIndex((a) => a.area.id === area.id) ?? 0))] },
    }]) },
    vacant: { type: 'FeatureCollection', features: filters.status !== 'vacant' ? [] : loaded.vacant.features.filter((f) => matchesReport(f.properties, filters)) },
  };
}
export function mountStorefrontLayers(map: MapLibreLike, loaded: LoadedStorefronts, initial: StorefrontFilters, handlers: () => FeatureHandlers | null) {
  removeStorefrontLayers(map);
  const empty = { type: 'FeatureCollection', features: [] };
  map.addSource('sf-boundaries', { type: 'geojson', data: empty, attribution: NTA_ATTRIBUTION_HTML });
  map.addSource('sf-labels', { type: 'geojson', data: empty, attribution: STOREFRONT_ATTRIBUTION_HTML });
  map.addSource('sf-vacant', { type: 'geojson', data: empty, attribution: STOREFRONT_ATTRIBUTION_HTML, cluster: true, clusterMaxZoom: 14, clusterRadius: 42 });
  map.addLayer({ id: 'sf-area-fill', maxzoom: 12, type: 'fill', source: 'sf-boundaries', paint: { 'fill-color': '#bd653e', 'fill-opacity': 0.15 } });
  map.addLayer({ id: 'sf-area-outline', maxzoom: 12, type: 'line', source: 'sf-boundaries', paint: { 'line-color': '#80543f', 'line-width': 1 } });
  map.addLayer({ id: 'sf-area-selected', type: 'line', source: 'sf-boundaries', filter: ['==', ['get', 'id'], ''], paint: { 'line-color': '#28201c', 'line-width': 3 } });
  map.addLayer({ id: 'sf-area-label', maxzoom: 12, type: 'symbol', source: 'sf-labels', layout: { 'text-field': ['concat', ['get', 'name'], '\n', ['get', 'borough'], ' · ', ['to-string', ['get', 'records']]], 'text-offset': ['get', 'offset'], 'text-size': 12, 'text-font': ['Noto Sans Regular'] }, paint: { 'text-color': '#3d2920', 'text-halo-color': '#fffaf4', 'text-halo-width': 2 } });
  map.addLayer({ id: 'sf-area-fill-high', minzoom: 12, type: 'fill', source: 'sf-boundaries', paint: { 'fill-color': '#bd653e', 'fill-opacity': 0.15 } });
  map.addLayer({ id: 'sf-area-outline-high', minzoom: 12, type: 'line', source: 'sf-boundaries', paint: { 'line-color': '#80543f', 'line-width': 1 } });
  map.addLayer({ id: 'sf-area-label-high', minzoom: 12, type: 'symbol', source: 'sf-labels', layout: { 'text-field': ['concat', ['get', 'name'], '\n', ['get', 'borough'], ' · ', ['to-string', ['get', 'records']]], 'text-offset': ['get', 'offset'], 'text-size': 12, 'text-font': ['Noto Sans Regular'] }, paint: { 'text-color': '#3d2920', 'text-halo-color': '#fffaf4', 'text-halo-width': 2 } });
  map.addLayer({ id: 'sf-clusters', type: 'circle', source: 'sf-vacant', minzoom: 12, filter: ['has', 'point_count'], paint: { 'circle-color': '#a95231', 'circle-radius': ['step', ['get', 'point_count'], 17, 100, 23, 500, 29], 'circle-stroke-color': '#fffaf4', 'circle-stroke-width': 2 } });
  map.addLayer({ id: 'sf-cluster-label', type: 'symbol', source: 'sf-vacant', minzoom: 12, filter: ['has', 'point_count'], layout: { 'text-field': ['get', 'point_count_abbreviated'], 'text-size': 12, 'text-font': ['Noto Sans Regular'] }, paint: { 'text-color': '#ffffff' } });
  map.addLayer({ id: 'sf-points', type: 'circle', source: 'sf-vacant', minzoom: 12, filter: ['!', ['has', 'point_count']], paint: { 'circle-color': '#a95231', 'circle-radius': 5, 'circle-stroke-color': '#fffaf4', 'circle-stroke-width': 1.5 } });
  map.addLayer({ id: 'sf-point-selected', type: 'circle', source: 'sf-vacant', minzoom: 12, filter: ['==', ['get', 'id'], ''], paint: { 'circle-color': 'transparent', 'circle-radius': 9, 'circle-stroke-color': '#28201c', 'circle-stroke-width': 3 } });
  let active = true;
  const subscriptions: MapSubscription[] = [];
  const selectable = ['sf-points', 'sf-clusters', 'sf-area-label', 'sf-area-fill', 'sf-area-label-high', 'sf-area-fill-high'];
  const click = (event: unknown) => {
    const point = (event as { point?: unknown })?.point;
    const hit: MapRenderedFeature | undefined = map.queryRenderedFeatures(point, { layers: selectable })[0];
    if (!hit) { handlers()?.onClearSelection(); return; }
    const clusterId = hit.properties?.cluster_id;
    if (typeof clusterId === 'number') {
      const source = map.getSource('sf-vacant') as { getClusterExpansionZoom?: (id: number) => Promise<number> } | undefined;
      source?.getClusterExpansionZoom?.(clusterId).then((zoom) => {
        if (active && hit.geometry?.coordinates) map.easeTo({ center: hit.geometry.coordinates, zoom });
      }).catch((error: unknown) => { if (active) handlers()?.onError(error instanceof Error ? error : new Error(String(error))); });
      return;
    }
    const id = hit.properties?.id;
    if (typeof id === 'string') handlers()?.onSelect(id);
  };
  subscriptions.push(map.on('click', click));
  for (const id of selectable) {
    subscriptions.push(map.on('mouseenter', id, () => { map.getCanvas().style.cursor = 'pointer'; }));
    subscriptions.push(map.on('mouseleave', id, () => { map.getCanvas().style.cursor = ''; }));
  }
  function setFilters(filters: StorefrontFilters): void {
    const data = storefrontMapData(loaded, filters);
    updateSource(map, 'sf-boundaries', data.boundaries); updateSource(map, 'sf-labels', data.labels); updateSource(map, 'sf-vacant', data.vacant);
    // Aggregate-only modes retain area labels at street zoom; vacant mode changes scale.
    for (const id of ['sf-area-label-high', 'sf-area-fill-high', 'sf-area-outline-high']) map.setFilter(id, filters.status === 'vacant' ? ['==', ['get', 'id'], ''] : null);
  }
  setFilters(initial);
  return {
    setFilters,
    setSelectedId(id: string | null) { map.setFilter('sf-area-selected', ['==', ['get', 'id'], id ?? '']); map.setFilter('sf-point-selected', ['==', ['get', 'id'], id ?? '']); },
    destroy() { active = false; subscriptions.forEach((s) => s.unsubscribe()); map.getCanvas().style.cursor = ''; removeStorefrontLayers(map); },
  };
}
