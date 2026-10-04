import type { Filters } from '../../lib/filters';
import { isBoroughFilter } from '../../lib/filters';
import type { ConstructionStatus, StorefrontArea, StorefrontProperties, StorefrontStatus } from '../../types/storefronts';

export type StatusFilter = 'vacant' | 'nonVacant' | 'both';
export type ConstructionFilter = 'any' | 'reported' | 'notReported' | 'unknown';
export interface StorefrontFilters extends Filters {
  readonly status: StatusFilter;
  readonly year: string;
  readonly construction: ConstructionFilter;
}
export const DEFAULT_STOREFRONT_FILTERS: StorefrontFilters = {
  type: 'all', borough: 'all', status: 'vacant', year: '2024', construction: 'any',
};
export function normalizeStorefrontFilters(value: unknown): StorefrontFilters {
  const raw = typeof value === 'object' && value !== null ? value as Partial<StorefrontFilters> : {};
  return {
    type: 'all', borough: isBoroughFilter(raw.borough) ? raw.borough : 'all',
    status: raw.status === 'nonVacant' || raw.status === 'both' ? raw.status : 'vacant',
    year: typeof raw.year === 'string' && /^(?:20\d{2})(?: and 20\d{2})?$/.test(raw.year) ? raw.year : '2024',
    construction: raw.construction === 'reported' || raw.construction === 'notReported' || raw.construction === 'unknown' ? raw.construction : 'any',
  };
}
export function matchesConstruction(value: ConstructionStatus, filter: ConstructionFilter): boolean {
  return filter === 'any' || (filter === 'reported' && value === true)
    || (filter === 'notReported' && value === false) || (filter === 'unknown' && value === null);
}
export function matchesStatus(value: StorefrontStatus, filter: StatusFilter): boolean {
  return filter === 'both' || value === filter;
}
export function matchesReport(p: StorefrontProperties, filters: StorefrontFilters): boolean {
  return p.reportingYear === filters.year && filters.status !== 'nonVacant'
    && (filters.borough === 'all' || p.borough?.toLocaleLowerCase('en-US') === filters.borough.toLocaleLowerCase('en-US'))
    && matchesConstruction(p.construction, filters.construction);
}
export function matchesArea(area: StorefrontArea, filters: StorefrontFilters): boolean {
  return area.reportingYear === filters.year && (filters.borough === 'all' || area.borough?.toLocaleLowerCase('en-US') === filters.borough.toLocaleLowerCase('en-US'));
}
export function summarizeArea(area: StorefrontArea, construction: ConstructionFilter = 'any') {
  const result = { total: 0, vacant: 0, nonVacant: 0, unknown: 0, mappable: 0, constructionReported: 0, constructionNotReported: 0, constructionUnknown: 0 };
  for (const [status, value, records, mappable] of area.counts) {
    if (!matchesConstruction(value, construction)) continue;
    result.total += records;
    result[status] += records;
    result.mappable += mappable;
    result[value === null ? 'constructionUnknown' : value ? 'constructionReported' : 'constructionNotReported'] += records;
  }
  return result;
}
