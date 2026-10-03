"""Lossless report-instance identities and explicit point exclusions."""
import hashlib
import math
import re
from collections import Counter
from datetime import datetime

if __package__:
    from .fetch import FIELDS, canonical
else:
    from fetch import FIELDS, canonical


BOROUGHS = {'MANHATTAN', 'BROOKLYN', 'QUEENS', 'BRONX', 'STATEN ISLAND'}

def text(row, field):
    value = row.get(field)
    if value is None or value == '':
        return None
    if not isinstance(value, str):
        raise ValueError(f'{field}: expected source text')
    return value

def status(value):
    if value is None or value == '': return 'unknown'
    if value in ('YES', 'Y'): return 'vacant'
    if value in ('NO', 'N'): return 'nonVacant'
    raise ValueError(f'Unknown status category {value!r}')

def construction(value):
    parsed = status(value)
    return None if parsed == 'unknown' else parsed == 'vacant'

def vintage(nta):
    if nta and re.fullmatch(r'[A-Z]{2}\d{2}', nta): return '2010'
    if nta and re.fullmatch(r'[A-Z]{2}\d{4}', nta): return '2020'
    return None

def date(row, field):
    value = text(row, field)
    if value is not None:
        try: datetime.fromisoformat(value.replace('Z', '+00:00'))
        except ValueError as error: raise ValueError(f'{field}: malformed source date {value!r}') from error
    return value

def coordinates(row):
    if row.get('latitude') is None or row.get('longitude') is None:
        return None, 'missing_coordinates'
    try: lat, lon = float(row['latitude']), float(row['longitude'])
    except (ValueError, TypeError): return None, 'invalid_coordinates'
    if not math.isfinite(lat) or not math.isfinite(lon) or not (-90 <= lat <= 90 and -180 <= lon <= 180):
        return None, 'invalid_coordinates'
    if lat == 0 and lon == 0: return None, 'zero_coordinates'
    return [round(lon, 7), round(lat, 7)], None

def clean_rows(rows):
    occurrences, digests = Counter(), {}
    exclusions, counters, cleaned = Counter(), Counter(), []
    for row in rows:
        raw = {field: row.get(field) for field in FIELDS}
        for field, value in raw.items():
            if value is None or value == '': counters[f'missing_{field}'] += 1
        encoded = canonical(raw)
        digest = hashlib.sha256(encoded.encode()).hexdigest()[:24]
        if digest in digests and digests[digest] != encoded: raise ValueError('Report digest collision')
        digests[digest] = encoded
        occurrences[digest] += 1
        year = text(row, 'reporting_year')
        if not year: raise ValueError('Missing reporting_year')
        borough = text(row, 'borough')
        if borough not in BOROUGHS: raise ValueError(f'Unknown borough {borough!r}')
        nta = text(row, 'nta')
        coords, reason = coordinates(row)
        if reason: exclusions[reason] += 1
        if nta is not None and vintage(nta) is None: counters['invalid_nta'] += 1
        if row.get('borough_block_lot') != row.get('bbl'): counters['reported_geocoded_bbl_disagreement'] += 1
        if row.get('zip_code') != row.get('postcode'): counters['reported_geocoded_zip_disagreement'] += 1
        for field in ('vacant_on_12_31', 'vacant_6_30_or_date_sold', 'construction_reported'):
            if row.get(field) in ('Y', 'N'): counters[f'{field}_short_variant'] += 1
            if row.get(field) is None or row.get(field) == '': counters[f'{field}_unknown'] += 1
        props = {'id': f'sf-{digest}-{occurrences[digest]}', 'reportingYear': year,
                 'address': text(row, 'property_street_address_or'), 'borough': borough,
                 'zip': text(row, 'zip_code'), 'bbl': text(row, 'borough_block_lot'),
                 'nta': nta, 'ntaVintage': vintage(nta), 'neighborhood': text(row, 'nbhd'),
                 'status': status(row.get('vacant_on_12_31')),
                 'construction': construction(row.get('construction_reported')),
                 'juneStatus': status(row.get('vacant_6_30_or_date_sold')),
                 'businessActivity': text(row, 'primary_business_activity'),
                 'leaseExpiration': date(row, 'expir_dt_of_most_recent_lease'),
                 'soldDate': date(row, 'sold_date'), 'filingDueDate': date(row, 'filing_due_date')}
        cleaned.append((props, coords))
    counters['repeated_identical_records_retained'] = sum(n - 1 for n in occurrences.values())
    counters['coordinate_rounding_precision'] = 7
    return cleaned, {'pipeline': dict(counters), 'pointExclusions': dict(exclusions)}
