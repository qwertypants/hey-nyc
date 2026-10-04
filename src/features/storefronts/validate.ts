import type { StorefrontAreas, StorefrontBoundaryCollection, StorefrontCollection, StorefrontMetadata, StorefrontPosition } from '../../types/storefronts';

function fail(message: string): never { throw new Error(`Invalid storefront data: ${message}`); }
function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail('expected object');
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, names: readonly string[]): void {
  if (Object.keys(value).length !== names.length || names.some((name) => !Object.hasOwn(value, name))) fail('unexpected or missing fields');
}
function string(value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.trim() === '' || value.length > 2000) fail('expected nonempty string');
}
function nullableString(value: unknown): void { if (value !== null) string(value); }
function count(value: unknown): asserts value is number { if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) fail('expected nonnegative integer'); }
function array(value: unknown): unknown[] { if (!Array.isArray(value)) fail('expected array'); return value; }
function status(value: unknown): void { if (typeof value !== 'string' || !['vacant', 'nonVacant', 'unknown'].includes(value)) fail('invalid status'); }
function construction(value: unknown): void { if (value !== true && value !== false && value !== null) fail('invalid construction status'); }
function vintage(value: unknown): void { if (value !== '2010' && value !== '2020') fail('invalid NTA vintage'); }
function position(value: unknown): asserts value is StorefrontPosition {
  const p = array(value);
  if (p.length !== 2 || p.some((n) => typeof n !== 'number' || !Number.isFinite(n))
    || Number(p[0]) < -74.3 || Number(p[0]) > -73.6 || Number(p[1]) < 40.4 || Number(p[1]) > 41) fail('invalid NYC coordinates');
}
function year(value: unknown): void { string(value); if (!/^20\d{2}(?: and 20\d{2})?$/.test(value)) fail('invalid reporting label'); }
function date(value: unknown): void { string(value); if (!Number.isFinite(Date.parse(value))) fail('invalid timestamp'); }
function source(value: unknown): void {
  const s = object(value); keys(s, ['datasetId', 'name', 'url', 'updatedAt']);
  string(s.datasetId); string(s.name); string(s.url); date(s.updatedAt);
  if (!/^https:\/\//.test(s.url)) fail('invalid source URL');
}
function unique(values: unknown[], key: (value: unknown) => unknown): void {
  const seen = new Set();
  for (const value of values) { const id = key(value); if (seen.has(id)) fail('duplicate id'); seen.add(id); }
}
export function validateMetadata(value: unknown): StorefrontMetadata {
  const m = object(value);
  keys(m, ['schemaVersion', 'methodologyVersion', 'source', 'boundarySources', 'retrievedAt', 'reportingYears', 'periodArtifacts', 'defaultReportingYear', 'sourceRows', 'publishedVacantLocations', 'coverage', 'contentHash']);
  if (m.schemaVersion !== 1 || m.defaultReportingYear !== '2024') fail('unsupported schema or default');
  string(m.methodologyVersion); source(m.source); array(m.boundarySources).forEach(source); date(m.retrievedAt);
  const years = array(m.reportingYears); years.forEach(year); unique(years, (y) => y);
  if (!years.includes('2024')) fail('default year absent');
  const artifacts = array(m.periodArtifacts); unique(artifacts, (p) => object(p).reportingYear);
  const paths = new Set<string>();
  for (const raw of artifacts) {
    const p = object(raw); keys(p, ['reportingYear', 'areasPath', 'vacantPath']); year(p.reportingYear);
    if (!years.includes(p.reportingYear)) fail('manifest year absent');
    for (const kind of ['areas', 'vacant'] as const) {
      const path = p[`${kind}Path`]; string(path);
      const suffix = kind === 'areas' ? 'areas.json' : 'vacant.geojson';
      const expected = p.reportingYear === '2024' ? suffix : `periods/${String(p.reportingYear).replaceAll(' ', '-')}/${suffix}`;
      if (path !== expected || paths.has(path)) fail('unsafe or duplicate artifact path');
      paths.add(path);
    }
  }
  if (artifacts.length !== years.length) fail('missing period artifacts');
  count(m.sourceRows); count(m.publishedVacantLocations); string(m.contentHash);
  if (!/^[0-9a-f]{64}$/.test(m.contentHash)) fail('invalid content hash');
  const coverage = array(m.coverage); unique(coverage, (c) => object(c).reportingYear);
  let total = 0; let points = 0;
  for (const raw of coverage) {
    const c = object(raw);
    keys(c, ['reportingYear', 'sourceRows', 'vacant', 'nonVacant', 'unknown', 'mappableRecords', 'publishedVacantLocations', 'unknownNtaRecords', 'vacancyShareSupported']);
    year(c.reportingYear); if (!years.includes(c.reportingYear)) fail('coverage year absent');
    for (const k of ['sourceRows', 'vacant', 'nonVacant', 'unknown', 'mappableRecords', 'publishedVacantLocations', 'unknownNtaRecords']) count(c[k]);
    if (typeof c.vacancyShareSupported !== 'boolean') fail('invalid share coverage');
    if (Number(c.vacant) + Number(c.nonVacant) + Number(c.unknown) !== c.sourceRows
      || Number(c.mappableRecords) > Number(c.sourceRows) || Number(c.unknownNtaRecords) > Number(c.sourceRows)
      || Number(c.publishedVacantLocations) > Number(c.vacant) || Number(c.publishedVacantLocations) > Number(c.mappableRecords)
      || (c.vacancyShareSupported && c.nonVacant === 0)) fail('coverage arithmetic');
    total += Number(c.sourceRows); points += Number(c.publishedVacantLocations);
  }
  if (coverage.length !== years.length || total !== m.sourceRows || points !== m.publishedVacantLocations) fail('metadata totals');
  return value as StorefrontMetadata;
}
export function validateAreas(value: unknown): StorefrontAreas {
  const root = object(value); keys(root, ['schemaVersion', 'areas']); if (root.schemaVersion !== 1) fail('unsupported area schema');
  const areas = array(root.areas); unique(areas, (a) => object(a).id);
  for (const raw of areas) {
    const a = object(raw); keys(a, ['id', 'reportingYear', 'nta', 'ntaVintage', 'name', 'borough', 'boundaryId', 'center', 'totalRecords', 'mappableRecords', 'counts']);
    string(a.id); if (!/^area-[a-f0-9]{24}$/.test(a.id)) fail('invalid area id'); year(a.reportingYear);
    for (const key of ['nta', 'name', 'borough', 'boundaryId']) nullableString(a[key]);
    if (a.ntaVintage !== null) vintage(a.ntaVintage);
    if (a.nta === null && a.ntaVintage !== null) fail('partial NTA identity');
    if (a.boundaryId !== null && a.boundaryId !== `${a.ntaVintage}:${a.nta}`) fail('boundary vintage mismatch');
    if (a.center !== null) position(a.center);
    if (a.ntaVintage === null && (a.center !== null || a.boundaryId !== null)) fail('invented unknown geography');
    count(a.totalRecords); count(a.mappableRecords);
    let total = 0; let mappable = 0; const cells = array(a.counts); unique(cells, (c) => { const cell = array(c); return `${cell[0]}:${cell[1]}`; });
    for (const rawCell of cells) {
      const c = array(rawCell); if (c.length !== 4) fail('invalid count cell');
      status(c[0]); construction(c[1]); count(c[2]); count(c[3]); if (c[3] > c[2]) fail('mappable exceeds reports');
      total += c[2]; mappable += c[3];
    }
    if (total !== a.totalRecords || mappable !== a.mappableRecords) fail('area arithmetic');
  }
  return value as StorefrontAreas;
}
export function validateVacant(value: unknown): StorefrontCollection {
  const root = object(value); keys(root, ['type', 'features']); if (root.type !== 'FeatureCollection') fail('expected collection');
  const features = array(root.features); unique(features, (f) => object(f).id);
  for (const raw of features) {
    const f = object(raw); keys(f, ['type', 'id', 'geometry', 'properties']);
    const p = object(f.properties); keys(p, ['id', 'reportingYear', 'address', 'borough', 'zip', 'bbl', 'nta', 'ntaVintage', 'neighborhood', 'status', 'construction', 'juneStatus', 'businessActivity', 'leaseExpiration', 'soldDate', 'filingDueDate']);
    if (f.type !== 'Feature' || f.id !== p.id || typeof p.id !== 'string' || !/^sf-[0-9a-f]{24}-[1-9]\d*$/.test(p.id)) fail('invalid report id');
    year(p.reportingYear); if (p.status !== 'vacant') fail('nonvacant point'); construction(p.construction); status(p.juneStatus);
    for (const key of ['address', 'borough', 'zip', 'bbl', 'nta', 'neighborhood', 'businessActivity', 'leaseExpiration', 'soldDate', 'filingDueDate']) nullableString(p[key]);
    if (p.ntaVintage !== null) vintage(p.ntaVintage);
    if (p.nta === null && p.ntaVintage !== null) fail('partial point NTA');
    const g = object(f.geometry); keys(g, ['type', 'coordinates']); if (g.type !== 'Point') fail('expected point'); position(g.coordinates);
  }
  return value as StorefrontCollection;
}
export function validateBoundaries(value: unknown): StorefrontBoundaryCollection {
  const root = object(value); keys(root, ['type', 'features']); if (root.type !== 'FeatureCollection') fail('expected boundary collection');
  const features = array(root.features); unique(features, (f) => object(f).id);
  for (const raw of features) {
    const f = object(raw); keys(f, ['type', 'id', 'geometry', 'properties']);
    const p = object(f.properties); keys(p, ['id', 'nta', 'ntaVintage', 'name', 'borough']);
    for (const key of ['id', 'nta', 'name', 'borough']) string(p[key]); vintage(p.ntaVintage);
    if (f.type !== 'Feature' || f.id !== p.id || p.id !== `${p.ntaVintage}:${p.nta}`) fail('invalid boundary identity');
    const g = object(f.geometry); keys(g, ['type', 'coordinates']);
    if (g.type !== 'Polygon' && g.type !== 'MultiPolygon') fail('invalid polygon');
    const polygons = g.type === 'Polygon' ? [array(g.coordinates)] : array(g.coordinates).map(array);
    if (polygons.length === 0) fail('empty polygon');
    for (const polygon of polygons) {
      if (polygon.length === 0) fail('missing exterior ring');
      for (const rawRing of polygon) {
        const ring = array(rawRing); if (ring.length < 4) fail('short ring'); ring.forEach(position);
        if (JSON.stringify(ring[0]) !== JSON.stringify(ring[ring.length - 1])) fail('unclosed ring');
      }
    }
  }
  return value as StorefrontBoundaryCollection;
}
export function validateArtifacts(metadata: unknown, areas: unknown, vacant: unknown, boundaries: unknown, reportingYear = '2024') {
  const result = { metadata: validateMetadata(metadata), areas: validateAreas(areas), vacant: validateVacant(vacant), boundaries: validateBoundaries(boundaries) };
  const boundaryIds = new Set(result.boundaries.features.map((f) => f.id));
  for (const area of result.areas.areas) {
    if (!result.metadata.reportingYears.includes(area.reportingYear)) fail('unknown area year');
    if (area.boundaryId !== null && !boundaryIds.has(area.boundaryId)) fail('missing boundary');
  }
  const selectedCoverage = result.metadata.coverage.filter((c) => c.reportingYear === reportingYear);
  if (selectedCoverage.length !== 1 || result.areas.areas.some((a) => a.reportingYear !== reportingYear) || result.vacant.features.some((f) => f.properties.reportingYear !== reportingYear)) fail('wrong cohort artifacts');
  for (const coverage of selectedCoverage) {
    const selected = result.areas.areas.filter((a) => a.reportingYear === coverage.reportingYear);
    if (selected.reduce((n, a) => n + a.totalRecords, 0) !== coverage.sourceRows || selected.reduce((n, a) => n + a.mappableRecords, 0) !== coverage.mappableRecords) fail('area reconciliation');
    const sums = { vacant: 0, nonVacant: 0, unknown: 0 };
    for (const a of selected) for (const [status, , n] of a.counts) sums[status] += n;
    for (const s of ['vacant', 'nonVacant', 'unknown'] as const) if (sums[s] !== coverage[s]) fail('status reconciliation');
    if (result.vacant.features.filter((f) => f.properties.reportingYear === coverage.reportingYear).length !== coverage.publishedVacantLocations) fail('point reconciliation');
  }
  if (result.vacant.features.some((f) => !result.metadata.reportingYears.includes(f.properties.reportingYear))) fail('unknown point year');
  return result;
}
