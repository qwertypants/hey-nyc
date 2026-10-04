"""Validate the complete staged or committed storefront artifact set."""
import argparse
from collections import Counter
import json
import math
from pathlib import Path
import re

if __package__:
    from .aggregate import material_hash, positions
else:
    from aggregate import material_hash, positions


FILES = ('metadata.json', 'areas.json', 'vacant.geojson', 'boundaries.geojson')
STATUSES = {'vacant', 'nonVacant', 'unknown'}

def require(condition, message):
    if not condition: raise ValueError(message)

def count(value):
    require(type(value) is int and value >= 0, f'Invalid count {value!r}')

def validate(artifacts):
    meta, areas, vacant, boundaries = [artifacts[f] for f in FILES]
    require(meta['schemaVersion'] == 1 and areas['schemaVersion'] == 1, 'Schema version')
    require(meta['defaultReportingYear'] == '2024', 'Default cohort changed')
    count(meta['sourceRows']); count(meta['publishedVacantLocations'])
    require(all(isinstance(y, str) and re.fullmatch(r'[0-9]{4}( and [0-9]{4})?', y) for y in meta['reportingYears']), 'Cohort labels')
    require(len(set(meta['reportingYears'])) == len(meta['reportingYears']), 'Repeated cohort')
    require('2024' in meta['reportingYears'], 'Default cohort missing')
    require(vacant['type'] == boundaries['type'] == 'FeatureCollection', 'Collection type')
    periods = {k: v for k, v in artifacts.items() if k not in FILES}
    require(meta['contentHash'] == material_hash(meta, areas, vacant, boundaries, periods), 'Material hash mismatch')
    require({p['reportingYear'] for p in meta['periodArtifacts']} == set(meta['reportingYears']), 'Period path cohorts')
    merged_areas, merged_points = [], []
    seen_paths = set()
    for p in meta['periodArtifacts']:
        prefix = '' if p['reportingYear'] == '2024' else 'periods/' + p['reportingYear'].replace(' ', '-') + '/'
        require(p['areasPath'] == prefix + 'areas.json' and p['vacantPath'] == prefix + 'vacant.geojson', 'Noncanonical period paths')
        for field in ('areasPath', 'vacantPath'):
            path = p[field]
            require(path not in seen_paths and not Path(path).is_absolute() and '..' not in Path(path).parts, 'Unsafe or repeated period path')
            seen_paths.add(path)
        cohort_areas = artifacts[p['areasPath']]
        cohort_points = artifacts[p['vacantPath']]
        require(cohort_areas['schemaVersion'] == 1 and cohort_points['type'] == 'FeatureCollection', 'Period schema')
        require(all(a['reportingYear'] == p['reportingYear'] for a in cohort_areas['areas']), 'Period area contamination')
        require(all(f['properties']['reportingYear'] == p['reportingYear'] for f in cohort_points['features']), 'Period point contamination')
        merged_areas.extend(cohort_areas['areas']); merged_points.extend(cohort_points['features'])
    require(seen_paths == set(artifacts) - {'metadata.json', 'boundaries.geojson'}, 'Extra period artifacts')
    areas = {'schemaVersion': 1, 'areas': merged_areas}
    vacant = {'type': 'FeatureCollection', 'features': merged_points}
    boundary_ids = set()
    for f in boundaries['features']:
        p = f['properties']; key = p['ntaVintage'] + ':' + p['nta']
        require(f['id'] == p['id'] == key and key not in boundary_ids, 'Boundary identity')
        boundary_ids.add(key)
        require(f['geometry']['type'] in ('Polygon', 'MultiPolygon'), 'Boundary geometry')
        coords = list(positions(f['geometry']['coordinates']))
        require(bool(coords), 'Empty boundary')
        for lon, lat in coords: require(math.isfinite(lon) and math.isfinite(lat) and -180 <= lon <= 180 and -90 <= lat <= 90, 'Boundary coordinate')
    sums, mapped, statuses, unknown_nta = Counter(), Counter(), {}, Counter()
    ids = set()
    for a in areas['areas']:
        require(re.fullmatch(r'area-[a-f0-9]{24}', a['id']) and a['id'] not in ids, 'Area identity')
        ids.add(a['id'])
        require(a['reportingYear'] in meta['reportingYears'], 'Area cohort')
        require(a['boundaryId'] is None or a['boundaryId'] in boundary_ids, 'Area boundary join')
        total = mappable = 0
        seen = set()
        for s, c, n, m in a['counts']:
            require(s in STATUSES and (c is None or type(c) is bool), 'Matrix categories')
            require((s, c) not in seen, 'Repeated matrix cell'); seen.add((s, c))
            count(n); count(m); require(m <= n, 'Matrix mappable exceeds records')
            total += n; mappable += m
            statuses.setdefault(a['reportingYear'], Counter())[s] += n
        require(total == a['totalRecords'] and mappable == a['mappableRecords'], 'Area reconciliation')
        sums[a['reportingYear']] += total; mapped[a['reportingYear']] += mappable
        if a['ntaVintage'] is None: unknown_nta[a['reportingYear']] += total
    point_counts = Counter(); ids = set()
    for f in vacant['features']:
        p = f['properties']; identifier = p['id']
        require(re.fullmatch(r'sf-[a-f0-9]{24}-[1-9][0-9]*', identifier) and identifier not in ids and f['id'] == identifier, 'Point identity')
        ids.add(identifier)
        require(f['type'] == 'Feature' and f['geometry']['type'] == 'Point', 'Point geometry')
        require(p['status'] == 'vacant' and p['juneStatus'] in STATUSES and (p['construction'] is None or type(p['construction']) is bool), 'Point category')
        lon, lat = f['geometry']['coordinates']
        require(math.isfinite(lon) and math.isfinite(lat) and -180 <= lon <= 180 and -90 <= lat <= 90 and (lon != 0 or lat != 0), 'Point coordinate')
        require(p['reportingYear'] in meta['reportingYears'], 'Point cohort')
        require(p['ntaVintage'] in ('2010', '2020', None), 'Point vintage')
        for field in ('address', 'borough', 'zip', 'bbl', 'nta', 'neighborhood', 'businessActivity', 'leaseExpiration', 'soldDate', 'filingDueDate'):
            require(p[field] is None or isinstance(p[field], str), f'Point text {field}')
        point_counts[p['reportingYear']] += 1
    require({c['reportingYear'] for c in meta['coverage']} == set(meta['reportingYears']), 'Coverage cohorts')
    for c in meta['coverage']:
        year = c['reportingYear']
        for field in ('sourceRows', 'vacant', 'nonVacant', 'unknown', 'mappableRecords', 'publishedVacantLocations', 'unknownNtaRecords'): count(c[field])
        require(c['sourceRows'] == sums[year] == sum(c[s] for s in STATUSES), 'Cohort source reconciliation')
        require(all(c[s] == statuses[year][s] for s in STATUSES), 'Cohort status reconciliation')
        require(c['mappableRecords'] == mapped[year] and c['publishedVacantLocations'] == point_counts[year], 'Cohort point reconciliation')
        require(c['unknownNtaRecords'] == unknown_nta[year], 'NTA reconciliation')
        require(type(c['vacancyShareSupported']) is bool, 'Vacancy share support type')
        require(c['vacancyShareSupported'] == (c['nonVacant'] > 0), 'Unsupported vacancy share')
    require(meta['sourceRows'] == sum(sums.values()), 'Global source reconciliation')
    require(meta['publishedVacantLocations'] == len(vacant['features']), 'Global point reconciliation')
    return meta

def load(directory):
    artifacts = {f: json.loads((Path(directory) / f).read_text()) for f in FILES}
    for period in artifacts['metadata.json']['periodArtifacts']:
        for field in ('areasPath', 'vacantPath'):
            path = period[field]
            require(not Path(path).is_absolute() and '..' not in Path(path).parts, 'Unsafe period path')
            if path not in artifacts: artifacts[path] = json.loads((Path(directory) / path).read_text())
    return artifacts

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--strict', action='store_true', help='All contract and reconciliation checks are always strict')
    parser.add_argument('--output-dir', type=Path, default=Path(__file__).resolve().parents[2] / 'public/data/storefronts')
    args = parser.parse_args()
    try:
        meta = validate(load(args.output_dir))
        print(f'Valid: {meta["sourceRows"]} reported records; {meta["publishedVacantLocations"]} vacant points')
    except (ValueError, KeyError, TypeError, OSError) as error:
        raise SystemExit(f'Storefront validation failed: {error}')
