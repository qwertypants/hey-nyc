"""Refresh public Storefront Explore artifacts from metadata-consistent cached sources."""
import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import shutil
import tempfile

if __package__:
    from .aggregate import aggregate, boundary_collection, material_hash, partition
    from .clean import clean_rows
    from .fetch import DATASET, FIELDS, HOST, cached_read, code_hash, open_cache
    from .validate import FILES, load, validate
else:
    from aggregate import aggregate, boundary_collection, material_hash, partition
    from clean import clean_rows
    from fetch import DATASET, FIELDS, HOST, cached_read, code_hash, open_cache
    from validate import FILES, load, validate





ROOT = Path(__file__).resolve().parents[2]
METHOD = 'reported-records-explore-v1'
BOUNDARY = '9nt8-h7nd'
BOUNDARY_FIELDS = {'nta2020': 'text', 'ntaname': 'text', 'boroname': 'text', 'the_geom': 'multipolygon'}

def source(meta):
    return {'datasetId': meta['id'], 'name': meta['name'], 'url': f'{HOST}/d/{meta["id"]}',
            'updatedAt': datetime.fromtimestamp(meta['rowsUpdatedAt'], timezone.utc).isoformat().replace('+00:00', 'Z')}

def drift(previous, current):
    """Historical cohorts are stable: refuse deletion beyond evidence's 1.45% missing points.

    5% tolerates routine corrections while a bulk schema/mapping failure cannot publish.
    New cohorts are permitted and never automatically become the default.
    """
    old = {c['reportingYear']: c for c in previous['coverage']}
    new = {c['reportingYear']: c for c in current['coverage']}
    for year, c in old.items():
        if year not in new: raise ValueError(f'Drift: removed cohort {year}')
        for field in ('sourceRows', 'mappableRecords'):
            if c[field] and abs(new[year][field] - c[field]) > c[field] * .05:
                raise ValueError(f'Drift: {year} {field} changed more than 5%')

def write_report(path, report):
    Path(path).write_text(json.dumps(report, ensure_ascii=False, indent=2, allow_nan=False) + '\n')

def report_consistent(path, report):
    try: previous = json.loads(Path(path).read_text())
    except (OSError, ValueError): return False
    if not isinstance(previous, dict): return False
    volatile = {'retrievedAt', 'sourceUpdatedAt'}
    return ({k: v for k, v in previous.items() if k not in volatile}
            == {k: v for k, v in report.items() if k not in volatile})

def repair_report(path, report):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, name = tempfile.mkstemp(prefix='.storefront-report-', dir=path.parent)
    os.close(fd)
    temporary = Path(name)
    try:
        write_report(temporary, report)
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)

def publish(directory, artifacts, report_path=None, report=None):
    directory = Path(directory)
    directory.parent.mkdir(parents=True, exist_ok=True)
    stage = Path(tempfile.mkdtemp(prefix='.storefront-stage-', dir=directory.parent))
    backup = directory.parent / ('.' + directory.name + '-backup')
    report_path = Path(report_path) if report_path is not None else None
    internal_report = report_path == directory / 'report.json'
    report_stage = report_backup = None
    public_backed = public_replaced = report_backed = report_replaced = False
    try:
        for name, value in artifacts.items():
            (stage / name).parent.mkdir(parents=True, exist_ok=True)
            (stage / name).write_text(json.dumps(value, ensure_ascii=False, separators=(',', ':'), allow_nan=False) + '\n')
        validate(load(stage))
        if backup.exists(): raise ValueError(f'Recovery backup exists: {backup}')
        if report_path is not None:
            if report is None: raise ValueError('Publication report missing')
            if internal_report:
                write_report(stage / 'report.json', report)
            else:
                report_path.parent.mkdir(parents=True, exist_ok=True)
                report_backup = report_path.parent / ('.' + report_path.name + '-backup')
                if report_backup.exists(): raise ValueError(f'Recovery backup exists: {report_backup}')
                fd, name = tempfile.mkstemp(prefix='.storefront-report-', dir=report_path.parent)
                os.close(fd)
                report_stage = Path(name)
                write_report(report_stage, report)
        if directory.exists():
            os.replace(directory, backup)
            public_backed = True
        os.replace(stage, directory)
        public_replaced = True
        if report_stage is not None:
            if report_path.exists():
                os.replace(report_path, report_backup)
                report_backed = True
            os.replace(report_stage, report_path)
            report_replaced = True
    except BaseException:
        if report_replaced: report_path.unlink()
        if report_backed: os.replace(report_backup, report_path)
        if public_replaced: shutil.rmtree(directory)
        if public_backed: os.replace(backup, directory)
        raise
    finally:
        if stage.exists(): shutil.rmtree(stage)
        if report_stage is not None: report_stage.unlink(missing_ok=True)
    if public_backed: shutil.rmtree(backup)
    if report_backed: report_backup.unlink()

def refresh(output_dir=None, cache=None, force=False, offline=False, limit=None):
    if limit is not None: raise ValueError('--limit is inspection-only and cannot publish production artifacts')
    output_dir = Path(output_dir or ROOT / 'public/data/storefronts')
    cache = Path(cache or ROOT / 'data/cache/storefronts/source.sqlite3')
    with open_cache(cache) as db:
        db.execute('CREATE TABLE IF NOT EXISTS pipeline (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
        old_code = db.execute('SELECT value FROM pipeline WHERE key="codeHash"').fetchone()
        changed_code = old_code is None or old_code[0] != code_hash()
        dof_meta, rows = cached_read(db, DATASET, FIELDS, force or changed_code, offline)
        boundary_meta, boundary_rows = cached_read(db, BOUNDARY, BOUNDARY_FIELDS, force or changed_code, offline)
        cleaned, report = clean_rows(rows)
        boundaries = boundary_collection({'2020': boundary_rows})
        areas, vacant, coverage = aggregate(cleaned, boundaries)
        retrieved = datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')
        meta = {'schemaVersion': 1, 'methodologyVersion': METHOD, 'source': source(dof_meta),
                'boundarySources': [source(boundary_meta)], 'retrievedAt': retrieved,
                'reportingYears': [c['reportingYear'] for c in coverage], 'defaultReportingYear': '2024',
                'sourceRows': len(rows), 'publishedVacantLocations': len(vacant['features']),
                'coverage': coverage, 'contentHash': ''}
        artifacts, period_paths = partition(areas, vacant, meta['reportingYears'])
        meta['periodArtifacts'] = period_paths
        periods = {k: v for k, v in artifacts.items() if k not in ('areas.json', 'vacant.geojson')}
        meta['contentHash'] = material_hash(meta, artifacts['areas.json'], artifacts['vacant.geojson'], boundaries, periods)
        artifacts.update({'metadata.json': meta, 'boundaries.geojson': boundaries})
        validate(artifacts)
        report.update({'contentHash': meta['contentHash'], 'retrievedAt': retrieved,
                       'sourceUpdatedAt': meta['source']['updatedAt'], 'sourceRows': len(rows),
                       'publishedVacantLocations': len(vacant['features']), 'cohorts': coverage,
                       'retiredBoundarySource': 'q2z5-ai38 (HTTP 404; 2010 polygons unavailable)',
                       'boundaryCoordinatePrecision': 6,
                       'recordsWithoutBoundary': sum(a['totalRecords'] for a in areas['areas'] if a['boundaryId'] is None), 'inspection': {'sourceRows': len(rows), 'pointExclusions': report['pointExclusions']}})
        previous = None
        if output_dir.exists():
            previous = validate(load(output_dir))
            drift(previous, meta)
        report_path = ROOT / 'data/processed/storefronts/report.json' if output_dir == ROOT / 'public/data/storefronts' else output_dir / 'report.json'
        if previous and previous['contentHash'] == meta['contentHash']:
            if report_consistent(report_path, report):
                result = 'unchanged'
            else:
                report['retrievedAt'] = previous['retrievedAt']
                report['sourceUpdatedAt'] = previous['source']['updatedAt']
                repair_report(report_path, report)
                result = 'report-repaired'
        else:
            publish(output_dir, artifacts, report_path, report)
            result = 'published'
        with db: db.execute('INSERT OR REPLACE INTO pipeline VALUES ("codeHash", ?)', (code_hash(),))
        return result, meta

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--force', action='store_true')
    parser.add_argument('--offline', action='store_true')
    parser.add_argument('--limit', type=int, help='Refused for publication; use fetch/inspection for bounded research')
    parser.add_argument('--output-dir', type=Path)
    parser.add_argument('--cache', type=Path)
    args = parser.parse_args()
    try:
        result, meta = refresh(**vars(args))
        print(f'{result}: {meta["sourceRows"]} reports, {meta["publishedVacantLocations"]} vacant points, {meta["contentHash"]}')
    except (ValueError, KeyError, TypeError, OSError) as error:
        raise SystemExit(f'Storefront refresh failed: {error}')
