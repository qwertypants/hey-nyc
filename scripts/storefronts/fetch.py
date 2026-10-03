"""Public Socrata reads and transactional SQLite cache, standard library only."""
import hashlib
import json
import sqlite3
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

HOST = 'https://data.cityofnewyork.us'
DATASET = '92iy-9c3n'
FIELDS = {'filing_due_date': 'calendar_date', 'reporting_year': 'text',
          'borough_block_lot': 'text', 'property_street_address_or': 'text',
          'borough': 'text', 'zip_code': 'text', 'sold_date': 'calendar_date',
          'vacant_on_12_31': 'text', 'construction_reported': 'text',
          'vacant_6_30_or_date_sold': 'text', 'primary_business_activity': 'text',
          'expir_dt_of_most_recent_lease': 'calendar_date', 'property_number': 'text',
          'property_street': 'text', 'unit': 'text', 'borough_1': 'text',
          'postcode': 'text', 'latitude': 'number', 'longitude': 'number',
          'lat_long': 'point', 'community_board': 'text', 'council_district': 'text',
          'census_tract': 'text', 'bin': 'text', 'bbl': 'text', 'nta': 'text', 'nbhd': 'text'}

def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'), allow_nan=False)

def read_json(url):
    for attempt in range(4):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': 'EatOutsideNYC/1.0'}), timeout=90) as response:
                return json.load(response)
        except (urllib.error.URLError, TimeoutError):
            if attempt == 3:
                raise
            time.sleep(2 ** attempt)

def metadata(dataset):
    return read_json(f'{HOST}/api/views/{dataset}.json')

def signature(meta):
    return canonical({k: meta.get(k) for k in ('id', 'rowsUpdatedAt', 'viewLastModified', 'columns')})

def check_schema(meta, required):
    actual = {c['fieldName']: c['dataTypeName'] for c in meta['columns']}
    for field, kind in required.items():
        if actual.get(field) != kind:
            raise ValueError(f'{meta["id"]}: schema drift {field}: expected {kind}, got {actual.get(field)}')

def fetch_rows(dataset, limit=None):
    offset, rows = 0, []
    while True:
        size = min(10000, limit - offset) if limit is not None else 10000
        if size <= 0:
            break
        query = urllib.parse.urlencode({'$order': ':id', '$limit': size, '$offset': offset})
        page = read_json(f'{HOST}/resource/{dataset}.json?{query}')
        if not isinstance(page, list):
            raise ValueError('Expected Socrata row array')
        rows.extend(page)
        offset += len(page)
        if len(page) < size:
            break
    if limit is None:
        query = urllib.parse.urlencode({'$select': 'count(*) AS count'})
        expected = int(read_json(f'{HOST}/resource/{dataset}.json?{query}')[0]['count'])
        if len(rows) != expected: raise ValueError(f'{dataset}: pagination count mismatch {len(rows)} != {expected}')
    return rows

def open_cache(path):
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(path)
    db.execute('CREATE TABLE IF NOT EXISTS snapshots (dataset TEXT PRIMARY KEY, metadata TEXT NOT NULL, rows TEXT NOT NULL)')
    return db

def cached_read(db, dataset, required, force=False, offline=False, limit=None):
    cached = db.execute('SELECT metadata, rows FROM snapshots WHERE dataset=?', (dataset,)).fetchone()
    if offline:
        if not cached:
            raise ValueError(f'No cached snapshot for {dataset}')
        meta, rows = map(json.loads, cached)
        check_schema(meta, required)
        return meta, rows
    before = metadata(dataset)
    check_schema(before, required)
    if cached and not force and limit is None and signature(json.loads(cached[0])) == signature(before):
        return before, json.loads(cached[1])
    rows = fetch_rows(dataset, limit)
    after = metadata(dataset)
    if signature(before) != signature(after):
        raise ValueError(f'{dataset}: metadata changed while paginating; retry a fresh snapshot')
    if limit is None:
        with db:
            db.execute('INSERT OR REPLACE INTO snapshots VALUES (?, ?, ?)', (dataset, canonical(before), canonical(rows)))
    return before, rows

def code_hash():
    h = hashlib.sha256()
    for path in sorted(Path(__file__).parent.glob('*.py')):
        h.update(path.name.encode()); h.update(path.read_bytes())
    return h.hexdigest()
