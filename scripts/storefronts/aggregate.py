"""Vintage-matched geography, sparse record matrices and separate vacant points."""
from collections import Counter, defaultdict
import hashlib
import math
import re

if __package__:
    from .fetch import canonical
else:
    from fetch import canonical



def positions(value):
    if isinstance(value, list) and len(value) == 2 and all(isinstance(v, (int, float)) for v in value):
        yield value
    elif isinstance(value, list):
        for item in value: yield from positions(item)


def boundary_collection(sources):
    features, seen = [], set()
    for vintage, rows in sources.items():
        for row in rows:
            code = row['nta2020'] if vintage == '2020' else row['ntacode']
            key = vintage + ':' + code
            if key in seen: raise ValueError(f'Duplicate boundary {key}')
            seen.add(key)
            geometry = row['the_geom']
            if geometry['type'] not in ('Polygon', 'MultiPolygon'): raise ValueError('Non-polygon boundary')
            # Preserve every vertex and ring, reducing only redundant coordinate precision.
            def rounded(value):
                return [rounded(v) for v in value] if isinstance(value, list) else round(value, 6)
            geometry = {'type': geometry['type'], 'coordinates': rounded(geometry['coordinates'])}
            features.append({'type': 'Feature', 'id': key, 'geometry': geometry,
                             'properties': {'id': key, 'nta': code, 'ntaVintage': vintage,
                                            'name': row['ntaname'], 'borough': row.get('boroname', row.get('boro_name'))}})
    return {'type': 'FeatureCollection', 'features': sorted(features, key=lambda f: f['id'])}


def aggregate(cleaned, boundaries):
    by_boundary = {f['id']: f for f in boundaries['features']}
    centers = {}
    for key, feature in by_boundary.items():
        coords = list(positions(feature['geometry']['coordinates']))
        centers[key] = [round((min(c[0] for c in coords) + max(c[0] for c in coords))/2, 6),
                        round((min(c[1] for c in coords) + max(c[1] for c in coords))/2, 6)]
    groups, coverage, points = {}, {}, []
    unmatched = Counter()
    label_coords = defaultdict(list)
    for props, coords in cleaned:
        year, nta, vintage = props['reportingYear'], props['nta'], props['ntaVintage']
        key = f'{vintage}:{nta}' if vintage and nta else None
        boundary = by_boundary.get(key)
        if not boundary: unmatched[year] += 1
        # Unknown source code remains its own group and is never assigned invented geometry.
        group_key = (year, nta, vintage, props['borough'])
        if group_key not in groups:
            groups[group_key] = {'id': 'area-' + hashlib.sha256(canonical(list(group_key)).encode()).hexdigest()[:24],
                                'reportingYear': year, 'nta': nta, 'ntaVintage': vintage,
                                'name': props['neighborhood'], 'borough': props['borough'],
                                'boundaryId': key if boundary else None,
                                'center': centers.get(key), 'totalRecords': 0, 'mappableRecords': 0, 'counts': {}}
        area = groups[group_key]
        if vintage == '2010' and coords is not None: label_coords[group_key].append(coords)
        area['totalRecords'] += 1
        area['mappableRecords'] += coords is not None
        cell = (props['status'], props['construction'])
        counts = area['counts'].setdefault(cell, [0, 0])
        counts[0] += 1; counts[1] += coords is not None
        if year not in coverage:
            coverage[year] = {'reportingYear': year, 'sourceRows': 0, 'vacant': 0, 'nonVacant': 0,
                              'unknown': 0, 'mappableRecords': 0, 'publishedVacantLocations': 0,
                              'unknownNtaRecords': 0, 'vacancyShareSupported': False}
        c = coverage[year]
        c['sourceRows'] += 1; c[props['status']] += 1; c['mappableRecords'] += coords is not None
        c['unknownNtaRecords'] += vintage is None
        if props['status'] == 'vacant' and coords is not None:
            points.append({'type': 'Feature', 'id': props['id'], 'geometry': {'type': 'Point', 'coordinates': coords}, 'properties': props})
            c['publishedVacantLocations'] += 1
    areas = []
    for group_key, area in groups.items():
        if area['ntaVintage'] == '2010' and label_coords[group_key]:
            coords = label_coords[group_key]
            area['center'] = [round(math.fsum(c[i] for c in coords) / len(coords), 7) for i in (0, 1)]
        area['counts'] = [[s, c, n, m] for (s, c), (n, m) in sorted(area['counts'].items(), key=lambda x: (x[0][0], str(x[0][1])))]
        areas.append(area)
    for c in coverage.values(): c['vacancyShareSupported'] = c['nonVacant'] > 0
    return ({'schemaVersion': 1, 'areas': sorted(areas, key=lambda a: a['id'])},
            {'type': 'FeatureCollection', 'features': sorted(points, key=lambda f: f['id'])},
            sorted(coverage.values(), key=lambda c: c['reportingYear']))


def material_hash(metadata, areas, vacant, boundaries, periods=None):
    material = dict(metadata)
    for key in ('contentHash', 'retrievedAt'): material.pop(key, None)
    material['source'] = {k: v for k, v in metadata['source'].items() if k != 'updatedAt'}
    material['boundarySources'] = [{k: v for k, v in source.items() if k != 'updatedAt'} for source in metadata['boundarySources']]
    return hashlib.sha256(canonical({'metadata': material, 'areas': areas, 'vacant': vacant, 'boundaries': boundaries, 'periods': periods or {}}).encode()).hexdigest()


def partition(areas, vacant, reporting_years):
    """Keep default payload small; every source cohort remains independently published."""
    artifacts, paths = {}, []
    for year in reporting_years:
        if not re.fullmatch(r'[0-9]{4}( and [0-9]{4})?', year):
            raise ValueError(f'Unreviewed reporting cohort label {year!r}')
        prefix = '' if year == '2024' else 'periods/' + year.replace(' ', '-') + '/'
        area_path, vacant_path = prefix + 'areas.json', prefix + 'vacant.geojson'
        paths.append({'reportingYear': year, 'areasPath': area_path, 'vacantPath': vacant_path})
        artifacts[area_path] = {'schemaVersion': 1, 'areas': [a for a in areas['areas'] if a['reportingYear'] == year]}
        artifacts[vacant_path] = {'type': 'FeatureCollection', 'features': [f for f in vacant['features'] if f['properties']['reportingYear'] == year]}
    return artifacts, paths
