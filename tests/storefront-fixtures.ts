import type { StorefrontArea, StorefrontBoundaryCollection, StorefrontCollection, StorefrontMetadata, StorefrontProperties } from '../src/types/storefronts';
import { validateArtifacts } from '../src/features/storefronts/validate';
export const AREA_ID = `area-${'a'.repeat(24)}`;
export const UNKNOWN_AREA_ID = `area-${'b'.repeat(24)}`;
export const REPORT_ID = `sf-${'c'.repeat(24)}-1`;
export const SOURCE = { datasetId: '92iy-9c3n', name: 'DOF reported records', url: 'https://data.cityofnewyork.us/92iy-9c3n', updatedAt: '2026-04-09T14:31:46Z' };
export const SF_METADATA: StorefrontMetadata = {
  schemaVersion: 1, methodologyVersion: '1', source: SOURCE, boundarySources: [{ ...SOURCE, datasetId: '9nt8-h7nd' }], retrievedAt: '2026-10-03T12:00:00Z', reportingYears: ['2024', '2025'], defaultReportingYear: '2024',
  periodArtifacts: [{ reportingYear: '2024', areasPath: 'areas.json', vacantPath: 'vacant.geojson' }, { reportingYear: '2025', areasPath: 'periods/2025/areas.json', vacantPath: 'periods/2025/vacant.geojson' }],
  sourceRows: 8, publishedVacantLocations: 3, contentHash: 'a'.repeat(64),
  coverage: [
    { reportingYear: '2024', sourceRows: 6, vacant: 2, nonVacant: 3, unknown: 1, mappableRecords: 5, publishedVacantLocations: 2, unknownNtaRecords: 2, vacancyShareSupported: true },
    { reportingYear: '2025', sourceRows: 2, vacant: 1, nonVacant: 0, unknown: 1, mappableRecords: 2, publishedVacantLocations: 1, unknownNtaRecords: 0, vacancyShareSupported: false },
  ],
};
export const SF_AREA: StorefrontArea = { id: AREA_ID, reportingYear: '2024', nta: 'MN0101', ntaVintage: '2020', name: 'Midtown Test', borough: 'Manhattan', boundaryId: '2020:MN0101', center: [-73.9855, 40.758], totalRecords: 4, mappableRecords: 4, counts: [['vacant', true, 1, 1], ['nonVacant', false, 2, 2], ['unknown', null, 1, 1]] };
export const SF_UNKNOWN_AREA: StorefrontArea = { ...SF_AREA, id: UNKNOWN_AREA_ID, name: null, nta: null, ntaVintage: null, boundaryId: null, center: null, totalRecords: 2, mappableRecords: 1, counts: [['vacant', null, 1, 1], ['nonVacant', true, 1, 0]] };
export const SF_REPORT: StorefrontProperties = { id: REPORT_ID, reportingYear: '2024', address: '12 TEST STREET', borough: 'Manhattan', zip: null, bbl: '1000010001', nta: 'MN0101', ntaVintage: '2020', neighborhood: 'Midtown Test', status: 'vacant', construction: true, juneStatus: 'unknown', businessActivity: 'OTHER', leaseExpiration: '2028-01-01T00:00:00', soldDate: null, filingDueDate: null };
export const SF_VACANT: StorefrontCollection = { type: 'FeatureCollection', features: [
  { type: 'Feature', id: REPORT_ID, geometry: { type: 'Point', coordinates: [-73.9855, 40.758] }, properties: SF_REPORT },
  { type: 'Feature', id: `sf-${'d'.repeat(24)}-1`, geometry: { type: 'Point', coordinates: [-73.987, 40.759] }, properties: { ...SF_REPORT, id: `sf-${'d'.repeat(24)}-1`, address: null, nta: null, ntaVintage: null, neighborhood: null, construction: null, businessActivity: null } },
] };
export const SF_BOUNDARIES: StorefrontBoundaryCollection = { type: 'FeatureCollection', features: [{ type: 'Feature', id: '2020:MN0101', properties: { id: '2020:MN0101', nta: 'MN0101', ntaVintage: '2020', name: 'Midtown Test', borough: 'Manhattan' }, geometry: { type: 'Polygon', coordinates: [[[-73.99, 40.75], [-73.98, 40.75], [-73.98, 40.76], [-73.99, 40.75]]] } }] };
export function sfArtifacts(year = '2024') {
  const areas = year === '2024' ? [SF_AREA, SF_UNKNOWN_AREA] : [{ ...SF_AREA, id: `area-${'e'.repeat(24)}`, reportingYear: year, totalRecords: 2, mappableRecords: 2, counts: [['vacant', null, 1, 1], ['unknown', null, 1, 1]] } as StorefrontArea];
  const vacant = year === '2024' ? SF_VACANT : { ...SF_VACANT, features: [{ ...SF_VACANT.features[0], type: 'Feature' as const, id: `sf-${'f'.repeat(24)}-1`, geometry: { type: 'Point' as const, coordinates: [-73.9855, 40.758] as [number, number] }, properties: { ...SF_REPORT, id: `sf-${'f'.repeat(24)}-1`, reportingYear: year, construction: null } }] };
  return validateArtifacts(SF_METADATA, { schemaVersion: 1, areas }, vacant, SF_BOUNDARIES, year);
}
export function sfPayload(path: string): unknown {
  if (path.endsWith('storefronts/metadata.json')) return SF_METADATA;
  if (path.endsWith('boundaries.geojson')) return SF_BOUNDARIES;
  const period = sfArtifacts(path.includes('/2025/') ? '2025' : '2024');
  return path.endsWith('areas.json') ? period.areas : period.vacant;
}
