#!/usr/bin/env python3
"""Fetch the raw NYC Open Data snapshot for dataset 6up2-gnw8.

    "Bicycle and Pedestrian Count Sensors" — 67 rows, 42 distinct `id`, small
    enough to fetch whole. Coordinates, names, travel modes, counter serials
    and the source's own first/last data columns all live here, so this is the
    only place the pipeline learns what a physical counter IS.

The snapshot is written canonically (rows sorted, compact JSON) rather than
byte-for-byte, because Socrata does not promise a stable row order and the
pipeline has to be able to tell a no-op re-run from a real change. The fetch
meta records the content hash that does that.

Standard library only. Usage:
    python3 scripts/walk/fetch_sensors.py [--raw PATH] [--meta PATH]
"""

from __future__ import annotations

import argparse
import importlib.util
import sys
from pathlib import Path
from typing import Any

# scripts/_common.py (the eat pipeline's contract) is already in sys.modules
# under the name `_common` by the time pytest collects both suites, so a plain
# `import _common` here would silently bind the WRONG contract. The walk
# contract is therefore loaded by path, once per process, under its own name.
if "walk_common" not in sys.modules:
    _spec = importlib.util.spec_from_file_location(
        "walk_common", Path(__file__).resolve().parent / "_common.py"
    )
    _walk_common = importlib.util.module_from_spec(_spec)
    sys.modules["walk_common"] = _walk_common
    _spec.loader.exec_module(_walk_common)
C = sys.modules["walk_common"]

#: 6up2-gnw8 has 67 rows. Fetched with headroom, and the count is verified
#: against the source so a truncated page can never look like a smaller dataset.
SENSORS_ROW_CEILING = 5000

# --------------------------------------------------------------------------- fetch


def fetch_view_meta() -> dict:
    """Dataset metadata: authoritative `rowsUpdatedAt` for the sensors view."""
    url = C.view_url(C.SENSORS_DATASET_ID)
    meta, _ = C.http_get_json(url, what="dataset metadata")
    if not isinstance(meta, dict):
        raise C.FetchError(f"{url}: expected a JSON object")
    if meta.get("id") != C.SENSORS_DATASET_ID:
        raise C.FetchError(
            f"{url}: returned id {meta.get('id')!r}, expected {C.SENSORS_DATASET_ID!r}"
        )
    return meta


def _as_rows(payload: Any, what: str) -> list[dict]:
    if isinstance(payload, dict) and "results" in payload:
        raise C.FetchError("endpoint returned a PagedDataset envelope; expected a row array")
    if not isinstance(payload, list):
        raise C.FetchError(f"{what}: expected a JSON array of rows, got {type(payload).__name__}")
    bad = [index for index, row in enumerate(payload) if not isinstance(row, dict)]
    if bad:
        raise C.FetchError(f"{what}: {len(bad)} entries are not objects (first at index {bad[0]})")
    return payload


def fetch_expected_row_count() -> int:
    """How many rows the whole dataset has. Cheap, and it is the only way to
    tell a complete fetch from a truncated one."""
    url = C.resource_url(C.SENSORS_DATASET_ID, {"$select": "count(*) as n", "$limit": "1"})
    payload, _ = C.http_get_json(url, what=f"{C.SENSORS_DATASET_ID} row count")
    rows = _as_rows(payload, "row count")
    if not rows or not str(rows[0].get("n", "")).isdigit():
        raise C.FetchError(f"{url}: could not read a row count from {rows!r}")
    return int(rows[0]["n"])


def fetch_rows(expected: int | None = None) -> tuple[list[dict], str]:
    """Every sensor row, canonicalised. Returns (rows, url-of-last-page)."""
    if expected is None:
        expected = fetch_expected_row_count()
    if expected > SENSORS_ROW_CEILING:
        raise C.FetchError(
            f"{C.SENSORS_DATASET_ID} now has {expected} rows, over the {SENSORS_ROW_CEILING} "
            "this fetch is willing to page through; raise the ceiling deliberately or re-read "
            "scripts/walk/_common.py first"
        )
    rows: list[dict] = []
    last_url = ""
    for offset in range(0, expected, C.FETCH_LIMIT):
        params = {"$select": "*", "$limit": str(min(C.FETCH_LIMIT, expected - offset)),
                  "$offset": str(offset), "$order": "id"}
        last_url = C.resource_url(C.SENSORS_DATASET_ID, params)
        payload, _ = C.http_get_json(last_url, what=f"{C.SENSORS_DATASET_ID} rows")
        rows.extend(_as_rows(payload, "rows"))
    if not rows:
        raise C.FetchError("the endpoint returned zero rows; refusing to overwrite the snapshot")
    if len(rows) != expected:
        raise C.FetchError(
            f"expected {expected} rows, got {len(rows)}; refusing to write a truncated snapshot"
        )
    return canonical_rows(rows), last_url


def canonical_rows(rows: list[dict]) -> list[dict]:
    """Sort by source `id` then by the row itself, so a re-run is byte-identical.

    Socrata gives no ordering guarantee without an explicit `$order`, and even
    with one, rows sharing an `id` come back in storage order. Sorting on the
    canonical serialisation of the row makes the snapshot independent of both.
    """
    return sorted(rows, key=lambda row: (str(row.get("id") or ""), C.canonical_json(row)))


def build_fetch_meta(rows: list[dict], view_meta: dict, url: str) -> dict:
    counters = summarise_counters(rows)
    return {
        "dataset": C.SENSORS_NAME,
        "datasetId": C.SENSORS_DATASET_ID,
        "url": url,
        "retrieved_at": C.iso_now(),
        "rowCount": len(rows),
        "distinctIds": len({C.normalise_text(row.get("id")) for row in rows}),
        "contentHash": C.sha256_hex(C.canonical_json(rows).encode("utf-8")),
        "rowsUpdatedAt": view_meta.get("rowsUpdatedAt"),
        "sourceUpdatedAt": C.epoch_to_iso(view_meta.get("rowsUpdatedAt")),
        "attribution": (view_meta.get("metadata") or {}).get("attribution")
        or view_meta.get("attribution")
        or C.ATTRIBUTION,
        "pedestrianCapableCounters": counters["counters"],
        "pedestrianCapableSourceIds": counters["sensorIds"],
        "counterSerials": counters["serials"],
    }


def summarise_counters(rows: list[dict]) -> dict:
    """What the fetch actually found, using the shared identity resolver.

    The headline number is counters, NOT rows: 10 pedestrian-capable rows
    resolve to fewer physical counters than that, and it is the counter's
    serial that everything downstream is keyed on.
    """
    ped = [row for row in rows if C.is_pedestrian_capable(row)]
    resolved = C.resolve_counter_identity(ped)
    return {
        "rows": len(rows),
        "pedestrianRows": len(ped),
        "counters": len(resolved),
        "sensorIds": sorted({value for group in resolved for value in group["sensorIds"]}),
        "serials": sorted(group["counterSerial"] for group in resolved),
    }


def run(
    *,
    raw_path: Path | None = None,
    meta_path: Path | None = None,
    view_meta: dict | None = None,
) -> dict:
    if view_meta is None:
        view_meta = fetch_view_meta()
    rows, url = fetch_rows()
    meta = build_fetch_meta(rows, view_meta, url)

    target = raw_path or C.SENSORS_RAW_PATH
    target.parent.mkdir(parents=True, exist_ok=True)
    C.write_json_file(target, rows)
    C.write_json_file(meta_path or C.SENSORS_META_PATH, meta)

    counters = summarise_counters(rows)
    print(f"rows                       {len(rows)}")
    print(f"distinct sensor ids        {meta['distinctIds']}")
    print(f"pedestrian-capable rows    {counters['pedestrianRows']}")
    print(f"pedestrian PHYSICAL ctrs   {counters['counters']}")
    for serial in counters["serials"]:
        print(f"  {serial}")
    print(f"rowsUpdatedAt              {meta['rowsUpdatedAt']} ({meta['sourceUpdatedAt']})")
    print(f"contentHash                {meta['contentHash']}")
    print(f"wrote                      {C.display_path(target)}")
    print(f"wrote                      {C.display_path(meta_path or C.SENSORS_META_PATH)}")
    return meta


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--raw", type=Path, default=None, help="raw snapshot to write")
    parser.add_argument("--meta", type=Path, default=None, help="fetch-meta sidecar to write")
    args = parser.parse_args(argv)
    try:
        run(raw_path=args.raw, meta_path=args.meta)
    except C.PipelineError as exc:
        print(f"fetch_sensors: {exc}", file=sys.stderr)
        return 1
    except KeyboardInterrupt:  # pragma: no cover
        print("fetch_sensors: interrupted", file=sys.stderr)
        return 130
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
