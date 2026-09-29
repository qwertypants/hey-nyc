#!/usr/bin/env python3
"""Download the raw NYC Open Data snapshot for the manual count program.

Fetches dataset `cqsj-cfgu` whole — 114 rows, small enough that paging and
`--since` windows buy nothing — plus the view metadata, whose `rowsUpdatedAt`
is the only authority on when the city last touched the data.

The response body is written through byte-for-byte, so
data/raw/walk/biannual-cqsj-cfgu.json is a verifiable copy of what was
published and data/raw/walk/history-fetch-meta.json records what we got, when
and how big. The transform refuses a snapshot that no longer matches its meta
(see transform.verify_raw_snapshot), so a truncated download cannot be cleaned
quietly.

THE HTTP CLIENT IS THE SHARED CONTRACT'S
========================================
`C.http_get` / `C.http_get_json` / `C.parse_json_body` are the ONE definition of
the retry policy for this pipeline: bounded exponential backoff with jitter, a
60s timeout, and retries for transient failures only. They live in
`scripts/walk/_common.py` because that module is the walk-side counterpart of
`scripts/_common.py` and deliberately does not import across to it — the two
pipelines have different lifetimes and a retune of the daily eat job's retry
policy must not silently retune this one. What that buys at the PIPEELINE
boundary does not apply at the HALF boundary: a copy of the client inside
`history/fetch.py` would be a second definition of the same policy inside the
same pipeline, and the two could drift apart silently. So this file has none.

The user agent is therefore `C.USER_AGENT` — one walk-pipeline identity for both
halves — not a history-specific variant. A log line that names the half already
exists: every message here is prefixed `walk/history/fetch`.

Usage:
    python3 scripts/walk/history/fetch.py
    python3 scripts/walk/history/fetch.py --raw tests/fixtures/cqsj.json
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path
from typing import Any

# Allow `python3 scripts/walk/history/fetch.py` and `import fetch` from a test
# with scripts/walk on sys.path. Two levels, not one: the shared contract lives
# in scripts/walk/, not scripts/.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import _common as C  # noqa: E402

# --------------------------------------------------------------------------- fetch


def resource_url() -> str:
    return C.resource_url(C.HISTORY_DATASET_ID, {"$limit": str(C.FETCH_LIMIT)})


def fetch_view_meta() -> dict:
    """Dataset metadata: the only authority on `rowsUpdatedAt`."""
    url = C.view_url(C.HISTORY_DATASET_ID)
    meta, _ = C.http_get_json(url, what="dataset metadata")
    if not isinstance(meta, dict):
        raise C.FetchError(f"{url}: expected a JSON object")
    if meta.get("id") != C.HISTORY_DATASET_ID:
        raise C.FetchError(
            f"{url}: returned id {meta.get('id')!r}, expected {C.HISTORY_DATASET_ID!r}"
        )
    return meta


def fetch_rows(*, view_meta: dict | None = None) -> tuple[list[dict], bytes, dict]:
    """Download every row. Returns (rows, raw_body, view_meta)."""
    if view_meta is None:
        view_meta = fetch_view_meta()
    url = resource_url()
    print(f"GET {url}")
    payload, body = C.http_get_json(url, what=f"{C.HISTORY_DATASET_ID} rows")

    if isinstance(payload, dict) and "results" in payload:
        raise C.FetchError("endpoint returned a PagedDataset envelope; expected a row array")
    if not isinstance(payload, list):
        raise C.FetchError(f"expected a JSON array of rows, got {type(payload).__name__}")
    if not payload:
        raise C.FetchError("the endpoint returned zero rows; refusing to overwrite the snapshot")
    bad = [index for index, row in enumerate(payload) if not isinstance(row, dict)]
    if bad:
        raise C.FetchError(f"{len(bad)} entries are not objects (first at index {bad[0]})")
    return payload, body, view_meta


def build_fetch_meta(rows: list[dict], body: bytes, view_meta: dict, *, url: str) -> dict:
    return {
        "dataset": C.HISTORY_NAME,
        "datasetId": C.HISTORY_DATASET_ID,
        "url": url,
        "retrievedAt": C.iso_now(),
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


def run(
    *,
    raw: Path | None = None,
    raw_out: Path | None = None,
    meta_out: Path | None = None,
) -> dict:
    """Fetch (or adopt) the snapshot, write it and its meta. Returns the meta.

    `raw` adopts an existing file instead of the network: tests inject a
    fixture through it, and it is how a snapshot recovered from an archive is
    re-used without pretending it was just downloaded. `retrievedAt` is still
    stamped honestly at the moment the snapshot was adopted.
    """
    raw_path = raw_out or C.HISTORY_RAW_PATH
    meta_path = meta_out or C.HISTORY_META_PATH

    if raw is not None:
        try:
            body = raw.read_bytes()
        except OSError as exc:
            raise C.FetchError(f"cannot read --raw {raw}: {exc}") from exc
        payload = C.parse_json_body(body, what=str(raw))
        if not isinstance(payload, list) or not payload:
            raise C.FetchError(f"{raw} must be a non-empty JSON array of rows")
        rows = [row for row in payload if isinstance(row, dict)]
        meta = {
            "dataset": C.HISTORY_NAME,
            "datasetId": C.HISTORY_DATASET_ID,
            "url": f"file://{raw}",
            "retrievedAt": C.iso_now(),
            "rowCount": len(rows),
            "responseSha256": C.sha256_hex(body),
            "responseBytes": len(body),
            "sourceUpdatedAt": None,
            "attribution": C.ATTRIBUTION,
            "adoptedFrom": str(raw),
        }
    else:
        view_meta = fetch_view_meta()
        rows, body, view_meta = fetch_rows(view_meta=view_meta)
        meta = build_fetch_meta(rows, body, view_meta, url=resource_url())

    C.write_text(raw_path, body.decode("utf-8"))
    C.write_json_file(meta_path, meta)

    print(f"rows            {meta['rowCount']}")
    print(f"bytes           {meta['responseBytes']:,}")
    print(f"sha256          {meta['responseSha256']}")
    print(f"rowsUpdatedAt   {meta.get('rowsUpdatedAt')} ({meta.get('sourceUpdatedAt')})")
    print(f"wrote           {C.display_path(raw_path)}")
    print(f"wrote           {C.display_path(meta_path)}")
    return meta


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument(
        "--raw",
        type=Path,
        default=None,
        help="adopt this snapshot instead of hitting the network (tests, archives)",
    )
    parser.add_argument(
        "--out", type=Path, default=None, help="where to write the raw snapshot"
    )
    parser.add_argument(
        "--meta", type=Path, default=None, help="where to write the fetch metadata"
    )
    args = parser.parse_args(argv)
    try:
        run(raw=args.raw, raw_out=args.out, meta_out=args.meta)
    except C.PipelineError as exc:
        print(f"walk/history/fetch: {exc}", file=sys.stderr)
        return 1
    except KeyboardInterrupt:  # pragma: no cover
        print("walk/history/fetch: interrupted", file=sys.stderr)
        return 130
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
