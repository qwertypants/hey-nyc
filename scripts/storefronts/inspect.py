"""Inspect retained raw reports without publishing or network calls."""
import argparse
import json
from collections import Counter
from pathlib import Path

if __package__:
    from .fetch import open_cache, DATASET
    from .clean import clean_rows
else:
    from fetch import open_cache, DATASET
    from clean import clean_rows




def inspect(rows):
    cleaned, report = clean_rows(rows)
    cohorts = {}
    for props, coords in cleaned:
        c = cohorts.setdefault(props['reportingYear'], Counter())
        c['records'] += 1; c[props['status']] += 1; c['mappable'] += coords is not None
    return {'sourceRows': len(rows), 'cohorts': cohorts, **report}

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--cache', type=Path, default=Path(__file__).resolve().parents[2] / 'data/cache/storefronts/source.sqlite3')
    args = parser.parse_args()
    with open_cache(args.cache) as db:
        row = db.execute('SELECT rows FROM snapshots WHERE dataset=?', (DATASET,)).fetchone()
        if not row: raise SystemExit('No cached source snapshot')
        print(json.dumps(inspect(json.loads(row[0])), indent=2))
