#!/usr/bin/env python3
"""Fetch the raw NYC Open Data snapshot for dataset fpeh-f7ci.

Standard library only. The response is written through byte-for-byte so
data/raw/fpeh-f7ci.json is a verifiable copy of what the city published, and
data/raw/fetch-meta.json records what we got and when.

Usage:
    python3 scripts/fetch_data.py
"""

from __future__ import annotations

import sys
from pathlib import Path

# Allow `import fetch_data` from tests/python as well as `python3 scripts/fetch_data.py`.
sys.path.insert(0, str(Path(__file__).resolve().parent))

import _common as C  # noqa: E402


def fetch_view_meta() -> dict:
    """Dataset metadata: authoritative `name`, `attribution` and `rowsUpdatedAt`."""
    meta, _ = C.http_get_json(C.VIEW_URL, what="dataset metadata")
    if not isinstance(meta, dict):
        raise C.FetchError(f"{C.VIEW_URL}: expected a JSON object")
    if meta.get("id") != C.DATASET_ID:
        raise C.FetchError(
            f"{C.VIEW_URL}: returned id {meta.get('id')!r}, expected {C.DATASET_ID!r}"
        )
    return meta


def fetch_rows(*, view_meta: dict | None = None) -> tuple[list[dict], bytes, dict]:
    """Download every row. Returns (rows, raw_body, view_meta)."""
    if view_meta is None:
        view_meta = fetch_view_meta()
    url = C.resource_url(C.FETCH_LIMIT, C.resource_select(view_meta))
    print(f"GET {url[:120]}{'...' if len(url) > 120 else ''}")
    payload, body = C.http_get_json(url, what=f"{C.DATASET_ID} rows")

    if isinstance(payload, dict) and "results" in payload:
        raise C.FetchError("endpoint returned a PagedDataset envelope; expected a row array")
    if not isinstance(payload, list):
        raise C.FetchError(f"expected a JSON array of rows, got {type(payload).__name__}")
    if not payload:
        raise C.FetchError("the endpoint returned zero rows; refusing to overwrite the snapshot")
    bad = [i for i, row in enumerate(payload) if not isinstance(row, dict)]
    if bad:
        raise C.FetchError(f"{len(bad)} entries are not objects (first at index {bad[0]})")
    return payload, body, view_meta


def build_fetch_meta(rows: list[dict], body: bytes, view_meta: dict) -> dict:
    return {
        "dataset": C.DATASET_NAME,
        "datasetId": C.DATASET_ID,
        "url": C.resource_url(C.FETCH_LIMIT, C.resource_select(view_meta)),
        "retrieved_at": C.iso_now(),
        "rowCount": len(rows),
        "responseSha256": C.sha256_hex(body),
        "responseBytes": len(body),
        "rowsUpdatedAt": view_meta.get("rowsUpdatedAt"),
        "rowsUpdatedBy": view_meta.get("rowsUpdatedBy"),
        "sourceUpdatedAt": C.epoch_to_iso(view_meta.get("rowsUpdatedAt")),
        "attribution": (view_meta.get("metadata") or {}).get("attribution")
        or view_meta.get("attribution")
        or C.ATTRIBUTION,
    }


def run() -> int:
    view_meta = fetch_view_meta()
    rows, body, view_meta = fetch_rows(view_meta=view_meta)
    meta = build_fetch_meta(rows, body, view_meta)

    C.RAW_DIR.mkdir(parents=True, exist_ok=True)
    C.write_text(C.RAW_DATA_PATH, body.decode("utf-8"))
    C.write_json_file(C.FETCH_META_PATH, meta)

    print(f"rows            {len(rows)}")
    print(f"bytes           {len(body):,}")
    print(f"sha256          {meta['responseSha256']}")
    print(f"rowsUpdatedAt   {meta['rowsUpdatedAt']} ({meta['sourceUpdatedAt']})")
    print(f"wrote           {C.display_path(C.RAW_DATA_PATH)}")
    print(f"wrote           {C.display_path(C.FETCH_META_PATH)}")
    return 0


def main(argv: list[str] | None = None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    if argv and argv[0] in ("-h", "--help"):
        print(__doc__)
        return 0
    try:
        return run()
    except C.PipelineError as exc:
        print(f"fetch_data: {exc}", file=sys.stderr)
        return 1
    except KeyboardInterrupt:  # pragma: no cover
        print("fetch_data: interrupted", file=sys.stderr)
        return 130


if __name__ == "__main__":
    raise SystemExit(main())
