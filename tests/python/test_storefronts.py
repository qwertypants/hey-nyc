"""Inline source fixtures; no network/socket dependency."""
import copy
import importlib.util
import json
from pathlib import Path
import sys
import pytest

MODULES = Path(__file__).resolve().parents[2] / 'scripts/storefronts'
# These module names do not overlap the existing pipeline's public modules.
from scripts.storefronts.clean import clean_rows, status, construction, vintage, coordinates
from scripts.storefronts.aggregate import aggregate, boundary_collection, material_hash, partition
from scripts.storefronts.fetch import canonical, open_cache, cached_read, FIELDS
from scripts.storefronts.refresh import refresh, publish, drift
from scripts.storefronts.validate import validate, FILES


def row(**changes):
    return {'reporting_year': '2024', 'borough': 'QUEENS', 'nta': 'QN0602',
            'nbhd': 'Forest Hills', 'latitude': '40.72', 'longitude': '-73.85',
            'vacant_on_12_31': 'YES', 'property_street_address_or': '100 QUEENS BLVD',
            'zip_code': '00123', 'borough_block_lot': '4000010001', **changes}


def bounds():
    return boundary_collection({'2020': [{'nta2020': 'QN0602', 'ntaname': 'Forest Hills', 'boroname': 'Queens',
        'the_geom': {'type': 'MultiPolygon', 'coordinates': [[[[-73.9,40.7],[-73.8,40.7],[-73.8,40.8],[-73.9,40.7]]]]}}]})


def artifacts(rows=None):
    cleaned, _ = clean_rows(rows or [row()]); b = bounds(); a, v, c = aggregate(cleaned, b)
    m = {'schemaVersion': 1, 'methodologyVersion': 'test', 'source': {'datasetId': 'x', 'name': 'x','url': 'https://example.test', 'updatedAt': 'date'},
         'boundarySources': [], 'retrievedAt': 'date', 'reportingYears': sorted({p['reportingYear'] for p, _ in cleaned}),
         'defaultReportingYear': '2024', 'sourceRows': len(cleaned), 'publishedVacantLocations': len(v['features']), 'coverage': c}
    result, paths = partition(a,v,m['reportingYears']);m['periodArtifacts']=paths
    periods={k:z for k,z in result.items() if k not in ('areas.json','vacant.geojson')}
    m['contentHash'] = material_hash(m,result['areas.json'],result['vacant.geojson'],b,periods)
    result.update({'metadata.json':m,'boundaries.geojson':b})
    return result


@pytest.mark.parametrize('value,result',[('YES','vacant'),('Y','vacant'),('NO','nonVacant'),('N','nonVacant'),(None,'unknown'),('','unknown')])
def test_status(value,result): assert status(value) == result

@pytest.mark.parametrize('value',['yes','TRUE','0','UNKNOWN',' Yes '])
def test_unknown_status_fatal(value):
    with pytest.raises(ValueError): status(value)


def test_construction_and_followup_never_overwrite_december():
    p = clean_rows([row(vacant_on_12_31='NO', vacant_6_30_or_date_sold='YES')])[0][0][0]
    assert p['status'] == 'nonVacant' and p['juneStatus'] == 'vacant' and p['construction'] is None
    assert construction('N') is False and construction('Y') is True


def test_repeat_identity_raw_fields_zip_and_dates():
    r = row(expir_dt_of_most_recent_lease='2099-12-31T00:00:00.000')
    cleaned, report = clean_rows([r,r])
    a,b = [p for p,_ in cleaned]
    assert a['id'].endswith('-1') and b['id'].endswith('-2')
    assert a['id'].rsplit('-',1)[0] == b['id'].rsplit('-',1)[0]
    assert a['zip'] == '00123' and a['leaseExpiration'] == r['expir_dt_of_most_recent_lease']
    assert report['pipeline']['repeated_identical_records_retained'] == 1
    with pytest.raises(ValueError): clean_rows([row(sold_date='bogus')])


@pytest.mark.parametrize('r,reason',[(row(latitude=None),'missing_coordinates'),(row(latitude='0',longitude='0'),'zero_coordinates'),(row(latitude='nan'),'invalid_coordinates')])
def test_point_exclusions_preserve_aggregates(r,reason):
    cleaned, report = clean_rows([r]); a,v,c = aggregate(cleaned,bounds())
    assert report['pointExclusions'] == {reason:1}
    assert a['areas'][0]['totalRecords'] == 1 and not v['features'] and c[0]['sourceRows'] == 1


def test_vintage_and_latest_share():
    assert vintage('MN17') == '2010' and vintage('MN0502') == '2020' and vintage('0') is None
    x = artifacts([row(),row(reporting_year='2025',vacant_on_12_31=None),row(reporting_year='2025')])
    assert x['metadata.json']['coverage'][1]['vacancyShareSupported'] is False
    validate(x)


def test_historical_no_cross_vintage_join():
    x=artifacts([row(),row(reporting_year='2019 and 2020',nta='QN60')])
    old=next(a for a in x['periods/2019-and-2020/areas.json']['areas'] if a['ntaVintage']=='2010')
    assert old['boundaryId'] is None and old['center'] == [-73.85,40.72]
    validate(x)


def test_hash_material_changes_and_timestamp_noop():
    x=artifacts(); original=x['metadata.json']['contentHash']
    x['metadata.json']['retrievedAt']='new';x['metadata.json']['source']['updatedAt']='new'
    assert material_hash(*(x[n] for n in FILES)) == original
    for name in ['areas.json','vacant.geojson','boundaries.geojson']:
        altered=copy.deepcopy(x)
        if name=='areas.json': altered[name]['areas'][0]['name']='change'
        else: altered[name]['features'][0]['properties']['name']='change'
        assert material_hash(*(altered[n] for n in FILES)) != original


@pytest.mark.parametrize('name',FILES)
def test_validator_rejects_corruption(name):
    x=artifacts();x[name]['corrupt']='field';
    # Material hash detects even additions to payloads.
    with pytest.raises(ValueError): validate(x)


def test_reconciliation_independent_of_hash():
    x=artifacts();x['areas.json']['areas'][0]['totalRecords']+=1
    x['metadata.json']['contentHash']=material_hash(*(x[n] for n in FILES))
    with pytest.raises(ValueError,match='reconciliation'):validate(x)


def test_publish_failure_leaves_original(tmp_path):
    directory=tmp_path/'published'; publish(directory,artifacts());before={p.name:p.read_bytes() for p in directory.iterdir()}
    bad=artifacts();bad['metadata.json']['sourceRows']=99
    with pytest.raises(ValueError):publish(directory,bad)
    assert {p.name:p.read_bytes() for p in directory.iterdir()}==before


def test_bounded_fetch_cannot_publish(tmp_path):
    with pytest.raises(ValueError,match='inspection-only'):refresh(output_dir=tmp_path/'out',limit=2)
    assert not (tmp_path/'out').exists()


def test_cache_schema_and_offline_no_network(tmp_path,monkeypatch):
    from scripts.storefronts import fetch
    db=open_cache(tmp_path/'cache.sqlite3')
    meta={'id':'x','columns':[{'fieldName':'reporting_year','dataTypeName':'text'}]}
    db.execute('INSERT INTO snapshots VALUES (?,?,?)',('x',json.dumps(meta),json.dumps([row()])))
    monkeypatch.setattr(fetch,'metadata',lambda *_: pytest.fail('network not allowed'))
    assert cached_read(db,'x',{'reporting_year':'text'},offline=True)[1]==[row()]
    with pytest.raises(ValueError,match='schema drift'):cached_read(db,'x',{'reporting_year':'number'},offline=True)


def test_metadata_mutation_rejects_cache_write(tmp_path,monkeypatch):
    from scripts.storefronts import fetch
    db=open_cache(tmp_path/'cache.sqlite3'); versions=iter([{'id':'x','columns':[],'rowsUpdatedAt':1},{'id':'x','columns':[],'rowsUpdatedAt':2}])
    monkeypatch.setattr(fetch,'metadata',lambda *_: next(versions));monkeypatch.setattr(fetch,'fetch_rows',lambda *_:[row()])
    with pytest.raises(ValueError,match='metadata changed'):cached_read(db,'x',{})
    assert db.execute('SELECT count(*) FROM snapshots').fetchone()[0]==0


def test_drift_guard():
    old={'coverage':[{'reportingYear':'2024','sourceRows':100,'mappableRecords':98}]}
    new={'coverage':[{'reportingYear':'2024','sourceRows':90,'mappableRecords':90}]}
    with pytest.raises(ValueError,match='changed'):drift(old,new)


def test_older_period_change_moves_hash_and_corruption_rejected():
    x=artifacts([row(),row(reporting_year='2023')]);old=x['metadata.json']['contentHash']
    x['periods/2023/vacant.geojson']['features'][0]['properties']['address']='Changed'
    periods={k:v for k,v in x.items() if k not in FILES}
    assert material_hash(*(x[n] for n in FILES),periods)!=old
    with pytest.raises(ValueError,match='hash'):validate(x)


def test_default_payload_partition_never_drops_reports():
    x=artifacts([row(),row(reporting_year='2023'),row(reporting_year='2025')])
    assert len(x['vacant.geojson']['features'])==1
    assert x['metadata.json']['publishedVacantLocations']==3
    assert {p['reportingYear'] for p in x['metadata.json']['periodArtifacts']}=={'2023','2024','2025'}
    validate(x)


def test_offline_refresh_noop_and_failure_safety(tmp_path,monkeypatch):
    from scripts.storefronts import fetch
    cache=tmp_path/'cache.sqlite3';out=tmp_path/'published'
    db=open_cache(cache)
    dof={'id':'92iy-9c3n','name':'DOF','rowsUpdatedAt':1,'columns':[{'fieldName':f,'dataTypeName':t} for f,t in FIELDS.items()]}
    boundary={'id':'9nt8-h7nd','name':'DCP','rowsUpdatedAt':1,'columns':[{'fieldName':f,'dataTypeName':t} for f,t in {'nta2020':'text','ntaname':'text','boroname':'text','the_geom':'multipolygon'}.items()]}
    raw_boundary={'nta2020':'QN0602','ntaname':'Forest Hills','boroname':'Queens','the_geom':bounds()['features'][0]['geometry']}
    with db:
        for m,rows in [(dof,[row()]),(boundary,[raw_boundary])]:db.execute('INSERT INTO snapshots VALUES (?,?,?)',(m['id'],json.dumps(m),json.dumps(rows)))
    monkeypatch.setattr(fetch,'metadata',lambda *_:pytest.fail('network forbidden'))
    assert refresh(output_dir=out,cache=cache,offline=True)[0]=='published'
    before={p.relative_to(out):p.read_bytes() for p in out.rglob('*') if p.is_file()}
    assert refresh(output_dir=out,cache=cache,offline=True)[0]=='unchanged'
    assert {p.relative_to(out):p.read_bytes() for p in out.rglob('*') if p.is_file()}==before
    with db:db.execute('UPDATE snapshots SET rows=? WHERE dataset=?',(json.dumps([row(vacant_on_12_31='BOGUS')]),'92iy-9c3n'))
    with pytest.raises(ValueError):refresh(output_dir=out,cache=cache,offline=True)
    assert {p.relative_to(out):p.read_bytes() for p in out.rglob('*') if p.is_file()}==before


def test_paginated_count_reconciliation(monkeypatch):
    from scripts.storefronts import fetch
    monkeypatch.setattr(fetch,'read_json',lambda url: [{'count':'2'}] if 'count' in url else [row()])
    with pytest.raises(ValueError,match='pagination count'):fetch.fetch_rows('x')


def test_directory_replace_failure_restores_prior(tmp_path,monkeypatch):
    from scripts.storefronts import refresh as module
    out=tmp_path/'published';publish(out,artifacts());old=(out/'metadata.json').read_bytes()
    replace=module.os.replace
    def fail_stage(src,dst):
        if Path(src).name.startswith('.storefront-stage-'):raise OSError('fixture replace failure')
        return replace(src,dst)
    monkeypatch.setattr(module.os,'replace',fail_stage)
    with pytest.raises(OSError):publish(out,artifacts())
    assert (out/'metadata.json').read_bytes()==old


def test_typescript_python_published_property_parity():
    import re
    source=(MODULES.parents[1]/'src/types/storefronts.ts').read_text()
    interface=source.split('export interface StorefrontProperties {',1)[1].split('\n}',1)[0]
    fields=set(re.findall(r'^  (\w+):',interface,re.MULTILINE))
    assert fields==set(artifacts()['vacant.geojson']['features'][0]['properties'])


def test_missing_nta_diagnostic_counted_once():
    _,report=clean_rows([row(nta=None)])
    assert report['pipeline']['missing_nta']==1


def test_historical_mean_anchor_stable_at_rounding_boundary():
    # Builtin sum changed algorithm in Python 3.12; fsum keeps generated coordinates
    # identical across supported interpreters when the mean is on a rounding boundary.
    import math
    source=[row(reporting_year='2019 and 2020',nta='QN60',longitude=str(lon))
            for lon in [-73.9777821]*7+[-73.9777822]*7]
    cleaned,_=clean_rows(source)
    areas,_,_=aggregate(cleaned,bounds())
    assert areas['areas'][0]['center'][0] == -73.9777822
    assert round(math.fsum(p[0] for _,p in cleaned)/len(cleaned),7) == -73.9777822


def install_refresh_source(tmp_path, monkeypatch):
    from scripts.storefronts import refresh as module
    monkeypatch.setattr(module,'ROOT',tmp_path)
    source_row=row()
    boundary_row={'nta2020':'QN0602','ntaname':'Forest Hills','boroname':'Queens','the_geom':bounds()['features'][0]['geometry']}
    def cached_source(db,dataset,*args):
        return {'id':dataset,'name':dataset,'rowsUpdatedAt':1}, [source_row] if dataset=='92iy-9c3n' else [boundary_row]
    monkeypatch.setattr(module,'cached_read',cached_source)
    return module,source_row,tmp_path/'public/data/storefronts',tmp_path/'data/processed/storefronts/report.json'


def publication_snapshot(directory, report):
    return ({p.relative_to(directory): (p.read_bytes(),p.stat().st_mtime_ns)
             for p in directory.rglob('*') if p.is_file()},report.read_bytes(),report.stat().st_mtime_ns)


@pytest.mark.parametrize('failure',['write','replace'])
def test_report_publication_failure_restores_public_and_report(tmp_path,monkeypatch,failure):
    module,source,directory,report=install_refresh_source(tmp_path,monkeypatch)
    assert module.refresh(offline=True)[0]=='published'
    original=publication_snapshot(directory,report)
    source['property_street_address_or']='Changed report address'
    with monkeypatch.context() as failing:
        if failure=='write':
            def fail_write(*args): raise OSError('injected report write failure')
            failing.setattr(module,'write_report',fail_write)
        else:
            real_replace=module.os.replace
            def fail_replace(src,dst):
                if Path(src).name.startswith('.storefront-report-') and Path(dst)==report:
                    raise OSError('injected report replace failure')
                return real_replace(src,dst)
            failing.setattr(module.os,'replace',fail_replace)
        with pytest.raises(OSError,match='report'):module.refresh(offline=True)
    assert publication_snapshot(directory,report)==original
    assert not (directory.parent/'.storefronts-backup').exists()
    assert not (report.parent/'.report.json-backup').exists()
    assert module.refresh(offline=True)[0]=='published'
    metadata=json.loads((directory/'metadata.json').read_text())
    assert metadata['contentHash']==json.loads(report.read_text())['contentHash']
    assert metadata['contentHash']!=json.loads(original[0][Path('metadata.json')][0])['contentHash']


@pytest.mark.parametrize('damage',['missing','stale','corrupt'])
def test_unchanged_refresh_repairs_inconsistent_report_without_public_churn(tmp_path,monkeypatch,damage):
    module,_,directory,report=install_refresh_source(tmp_path,monkeypatch)
    module.refresh(offline=True)
    original=publication_snapshot(directory,report)
    if damage=='missing':report.unlink()
    elif damage=='corrupt':report.write_text('{not valid json')
    else:
        old=json.loads(report.read_text());old['contentHash']='0'*64;old['pipeline']['missing_nta']=999
        report.write_text(json.dumps(old))
    assert module.refresh(offline=True)[0]=='report-repaired'
    repaired=publication_snapshot(directory,report)
    assert repaired[0]==original[0]
    assert repaired[1]==original[1]
    assert module.refresh(offline=True)[0]=='unchanged'
    assert publication_snapshot(directory,report)==repaired


def test_report_repair_failure_retains_stale_report_and_can_retry(tmp_path,monkeypatch):
    module,_,directory,report=install_refresh_source(tmp_path,monkeypatch)
    module.refresh(offline=True);report.write_text('{stale report}')
    original=publication_snapshot(directory,report)
    real_replace=module.os.replace
    with monkeypatch.context() as failing:
        def fail_replace(src,dst):
            if Path(dst)==report:raise OSError('injected repair failure')
            return real_replace(src,dst)
        failing.setattr(module.os,'replace',fail_replace)
        with pytest.raises(OSError,match='repair'):module.refresh(offline=True)
    assert publication_snapshot(directory,report)==original
    assert module.refresh(offline=True)[0]=='report-repaired'
