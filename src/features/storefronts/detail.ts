import type { StorefrontArea, StorefrontProperties } from '../../types/storefronts';
import type { FeatureDetail } from '../registry';
import type { LoadedStorefronts } from './load';
import { summarizeArea } from './filters';
import type { ConstructionFilter } from './filters';
const n = (value: number) => value.toLocaleString('en-US');
const missing = (value: string | null) => value ?? 'Not reported';
export function reportDetail(p: StorefrontProperties): FeatureDetail {
  return {
    title: p.address ?? 'Address not reported', headline: `Reported vacant · ${p.reportingYear}`,
    facts: [
      { label: 'Reporting label', value: p.reportingYear },
      { label: 'December status', value: 'Reported vacant' },
      { label: 'June / date sold status', value: p.juneStatus === 'unknown' ? 'Not reported' : p.juneStatus === 'vacant' ? 'Reported vacant' : 'Reported non-vacant' },
      { label: 'Construction', value: p.construction === null ? 'Unknown / not reported' : p.construction ? 'Reported' : 'Reported no' },
      { label: 'Borough', value: missing(p.borough) },
      { label: 'Neighborhood', value: missing(p.neighborhood) },
      { label: 'Source NTA / vintage', value: p.nta === null ? 'Unknown' : `${p.nta} · ${p.ntaVintage ?? 'vintage unknown'}` },
      { label: 'Reported ZIP', value: missing(p.zip) },
      { label: 'Reported BBL (property)', value: missing(p.bbl) },
      { label: 'Raw reported business activity', value: missing(p.businessActivity) },
      { label: 'Reported lease expiration', value: missing(p.leaseExpiration) },
      { label: 'Reported sale date', value: missing(p.soldDate) },
      { label: 'Filing due date', value: missing(p.filingDueDate) },
      { label: 'Report identifier', value: p.id },
    ],
    caveat: 'One owner-reported record, not a uniquely identified storefront. Repeated reports may overlap. Reported vacancy does not establish present availability, leasability or closure. Raw activity is not a verified previous business. Lease, sale and filing dates do not establish availability. Missing values mean unknown.',
  };
}
export function areaDetail(area: StorefrontArea, loaded: LoadedStorefronts, construction: ConstructionFilter): FeatureDetail {
  const summary = summarizeArea(area, construction);
  const siblings = area.boundaryId === null ? [] : loaded.areas.areas.filter((a) => a.id !== area.id && a.reportingYear === area.reportingYear && a.boundaryId === area.boundaryId);
  const supported = loaded.metadata.coverage.find((c) => c.reportingYear === area.reportingYear)?.vacancyShareSupported === true;
  return {
    title: area.name ?? (area.nta === null ? 'Unknown geography' : area.nta), headline: `Reported records · ${area.reportingYear}`,
    facts: [
      { label: 'Reporting label', value: area.reportingYear },
      { label: 'Source NTA / vintage', value: area.nta === null ? 'Unknown' : `${area.nta} · ${area.ntaVintage ?? 'vintage unknown'}` },
      { label: 'Borough', value: missing(area.borough) },
      { label: 'All reported records in source borough group', value: n(area.totalRecords) },
      ...siblings.map((a) => ({ label: `Other source borough group: ${a.borough ?? 'unknown'}`, value: `${n(a.totalRecords)} reported records (${n(summarizeArea(a, construction).vacant)} vacant under construction filter)` })),
      { label: 'Records under construction filter', value: n(summary.total) },
      { label: 'Reported vacant (December)', value: n(summary.vacant) },
      { label: 'Reported non-vacant (December)', value: n(summary.nonVacant) },
      { label: 'Unknown December status', value: n(summary.unknown) },
      { label: 'Reported vacancy share', value: supported && summary.total > 0 ? `${(100 * summary.vacant / summary.total).toFixed(1)}% (${n(summary.vacant)} / ${n(summary.total)})` : supported ? 'No records under the construction filter' : 'Unavailable: cohort does not support a denominator' },
      { label: 'Construction reported', value: n(summary.constructionReported) },
      { label: 'Construction reported no', value: n(summary.constructionNotReported) },
      { label: 'Construction unknown', value: n(summary.constructionUnknown) },
      { label: 'Records with valid coordinates', value: n(summary.mappable) },
      { label: 'Records without valid coordinates', value: n(summary.total - summary.mappable) },
      { label: 'Boundary coverage', value: area.boundaryId === null ? 'No authoritative polygon published for this source geography' : `Official DCP ${area.ntaVintage} NTA polygon` },
    ],
    caveat: 'Counts describe reported records, including unmapped records and repeated reports, not distinct storefront premises or current businesses. Vacancy share uses all reported records under the construction filter, including unknown December status. Non-vacant means owner-occupied or leased; it does not establish an active business. Status changes which areas are shown; the summary retains every status for context. Individual map points are reported-vacant records only. Source NTA vintages are kept separate. Source borough groups sharing one official NTA polygon remain separate reports; the polygon is not a borough correction.',
  };
}
