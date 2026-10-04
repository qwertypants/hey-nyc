/** Storefront Explore contract; see docs/adr/0008-explore-reported-storefront-records.md.
 * All counts are reported records. IDs identify reports, never persistent premises.
 * Python writer/validator and this file move together.
 */
export type StorefrontStatus = 'vacant' | 'nonVacant' | 'unknown';
export type NtaVintage = '2010' | '2020';
export type ConstructionStatus = boolean | null;
export type StorefrontPosition = [number, number];
/** Sparse rows: [December status, construction status, reported records, mappable records]. */
export type StorefrontCountCell = [StorefrontStatus, ConstructionStatus, number, number];
export interface StorefrontCoverage {
  reportingYear: string;
  sourceRows: number;
  vacant: number;
  nonVacant: number;
  unknown: number;
  mappableRecords: number;
  publishedVacantLocations: number;
  unknownNtaRecords: number;
  vacancyShareSupported: boolean;
}
export interface StorefrontSource {
  datasetId: string;
  name: string;
  url: string;
  updatedAt: string;
}
export interface StorefrontPeriodArtifacts {
  reportingYear: string;
  areasPath: string;
  vacantPath: string;
}
export interface StorefrontMetadata {
  schemaVersion: 1;
  methodologyVersion: string;
  source: StorefrontSource;
  boundarySources: StorefrontSource[];
  retrievedAt: string;
  reportingYears: string[];
  periodArtifacts: StorefrontPeriodArtifacts[];
  defaultReportingYear: '2024';
  sourceRows: number;
  publishedVacantLocations: number;
  coverage: StorefrontCoverage[];
  contentHash: string;
}
export interface StorefrontArea {
  id: string;
  reportingYear: string;
  nta: string | null;
  ntaVintage: NtaVintage | null;
  name: string | null;
  borough: string | null;
  boundaryId: string | null;
  center: StorefrontPosition | null;
  totalRecords: number;
  mappableRecords: number;
  counts: StorefrontCountCell[];
}
export interface StorefrontAreas {
  schemaVersion: 1;
  areas: StorefrontArea[];
}
export interface StorefrontProperties {
  /** sf- + 24 lowercase hex characters + '-' + positive occurrence integer. */
  id: string;
  reportingYear: string;
  address: string | null;
  borough: string | null;
  zip: string | null;
  bbl: string | null;
  nta: string | null;
  ntaVintage: NtaVintage | null;
  neighborhood: string | null;
  status: 'vacant';
  construction: ConstructionStatus;
  juneStatus: StorefrontStatus;
  businessActivity: string | null;
  leaseExpiration: string | null;
  soldDate: string | null;
  filingDueDate: string | null;
}
export interface StorefrontFeature {
  type: 'Feature';
  id: string;
  geometry: { type: 'Point'; coordinates: StorefrontPosition };
  properties: StorefrontProperties;
}
export interface StorefrontCollection {
  type: 'FeatureCollection';
  features: StorefrontFeature[];
}
export interface StorefrontBoundaryProperties {
  id: string;
  nta: string;
  ntaVintage: NtaVintage;
  name: string;
  borough: string;
}
export interface StorefrontBoundaryFeature {
  type: 'Feature';
  id: string;
  geometry: { type: 'MultiPolygon'; coordinates: StorefrontPosition[][][] }
    | { type: 'Polygon'; coordinates: StorefrontPosition[][] };
  properties: StorefrontBoundaryProperties;
}
export interface StorefrontBoundaryCollection {
  type: 'FeatureCollection';
  features: StorefrontBoundaryFeature[];
}
