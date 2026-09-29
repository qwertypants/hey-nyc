#!/usr/bin/env python3
"""Fetch pedestrian count rows from NYC Open Data dataset ct66-47at.

    "Bicycle and Pedestrian Counts" — 21.3M rows, of which pedestrian is
    1,505,220. This script NEVER fetches the dataset. There is no mode that
    does, and `--all` exists only so that asking for one is a loud refusal
    rather than an accident.

Three constraints shape everything here:

1. **Bounded windows.** Every fetch is a `$where` range on `timestamp`.
   `--latest` takes the most recent interval for the current state,
   `--since YYYY-MM-DD` resumes from a date, and the default takes only what a
   prior refresh has not already seen (the watermark in COUNTS_META_PATH).

2. **Server-side filtering.** `$where travelmode='pedestrian'` is always in the
   clause and `$select` names only the nine columns the build reads, so bike
   rows are never on the wire. The pedestrian share is 7% of the dataset; the
   `$select` is what keeps a bad `$where` from costing 21M rows.

3. **Socrata's offset ceiling.** `$limit` may be raised to 50000, but `$offset`
   is capped by the endpoint. The ceiling used here is `C.MAX_SOCRATA_OFFSET`
   (43,000), which is deliberately BELOW Socrata's own 43,043, because a
   ceiling you can hit is a ceiling that truncates. So a window is budgeted
   BEFORE it is fetched, and a window that would exceed the ceiling is refused
   with the arithmetic in the message. A silently truncated window would
   produce a baseline computed from a biased subset, which is worse than no
   baseline.

The written snapshot is canonical (rows sorted, deduped on the natural key,
compact JSON) and the meta records its content hash, so a no-op re-run produces
byte-identical output and is detectable.

Standard library only. Usage:
    python3 scripts/walk/fetch_counts.py [--latest | --since YYYY-MM-DD]
                                         [--baseline-window N] [--raw PATH] [--meta PATH]
"""

from __future__ import annotations

import argparse
import importlib.util
import math
import sys
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Iterable

if "walk_common" not in sys.modules:
    _spec = importlib.util.spec_from_file_location(
        "walk_common", Path(__file__).resolve().parent / "_common.py"
    )
    _walk_common = importlib.util.module_from_spec(_spec)
    sys.modules["walk_common"] = _walk_common
    _spec.loader.exec_module(_walk_common)
C = sys.modules["walk_common"]

#: The only travel mode this pipeline publishes. Present in every `$where`.
TRAVEL_MODE = "pedestrian"

#: The nine columns the build reads. `$select` is mandatory, not an
#: optimisation: `*` on this dataset would carry bike rows' worth of columns
#: across the wire for a dataset 93% bike.
COUNT_COLUMNS = (
    "sensor_id",
    "travelmode",
    "direction",
    "flowid",
    "flowname",
    "timestamp",
    "granularity",
    "counts",
    "status",
)

#: How much history a build needs in order to have a baseline at all. Eight
#: weeks is the smallest window that gives every (weekday × 15-minute bucket)
#: eight samples, which is what the ACTIVITY_CUTS ladder needs to be more than
#: a coin flip. It is also, for the two counters currently reporting, right at
#: the edge of what can be paged in one go: 2 counters × 2 twins × 2
#: directions × 96 intervals = 768 rows/day, so 56 days is 43,008 rows against
#: a `C.MAX_SOCRATA_OFFSET` of 43,000.
#:
#: That 8-row overshoot is real and is deliberately NOT hidden. It only bites
#: when the source's newest row is within minutes of `now`, and the feed runs
#: hours behind, so a full 56-day window measures ~42,548 rows and passes. If
#: the feed ever becomes genuinely current, a first run on a fresh checkout is
#: REFUSED by `check_window_budget` rather than silently truncated, and the
#: fix is `--baseline-window 55`. Raising the ceiling instead is not an option:
#: 43,008 rows cannot be paged in one request, and a second page at offset
#: 43,008 is past what the endpoint will serve.
DEFAULT_BASELINE_WINDOW_DAYS = 56

#: `--latest`: the most recent interval, for "is it reporting right now".
LATEST_INTERVAL_HOURS = 24

#: Re-requested on every incremental run so a row written between two runs, or
#: a boundary landing inside a second, cannot leave a permanent hole. The
#: overlap is deduped away, so it costs rows, not correctness.
OVERLAP_MINUTES = 30

#: One row of a counter's measurement. A counter has one flow per direction, so
#: this triple identifies a row exactly — verified against the live data, where
#: all 58,412 rows in a 76-day window are distinct under it.
ROW_KEY = ("sensor_id", "direction", "timestamp")


def round_half_up(value: float) -> int:
    return math.floor(value + 0.5)


# --------------------------------------------------------------------------- time

#: The `timestamp` COLUMN holds New York CIVIL time, so a `$where` bound has to
#: be written in civil time too. Socrata compares the literal against the
#: stored value, not against an instant, so a bound converted to a fixed
#: -05:00 offset is off by an hour for every summer window: the fetch silently
#: starts an hour late and ends an hour early. `datetime.now(utc)` is not a
#: bound, and neither is `datetime.now(utc) - 5h`.
def source_now() -> datetime:
    return datetime.now(timezone.utc).astimezone(C.NYC_TZ)


def to_source_iso(moment: datetime) -> str:
    """A bound in the shape Socrata parses: `2026-07-14T00:00:00`, no offset.

    The literal is the wall clock a New Yorker would read off the counter, in
    whatever frame the source recorded it — which is civil time, so this is
    `astimezone(NYC_TZ)`, not a fixed offset.
    """
    return moment.astimezone(C.NYC_TZ).strftime("%Y-%m-%dT%H:%M:%S")


# --------------------------------------------------------------------------- where

UNBOUNDED_COST = (
    "ct66-47at holds 21,300,000 rows and is never fetched whole. An unbounded "
    "read would transfer roughly 1.5 GB of JSON, blow past Socrata's 43,043-row "
    "offset ceiling anyway, and produce a snapshot no build can use. Ask for a "
    "window instead: --latest, --since YYYY-MM-DD, or the default incremental "
    "run that reads its start point from the watermark in the fetch meta."
)


def refuse_unbounded() -> None:
    """There is no whole-dataset mode. Asking for one is an error, by design."""
    raise C.PipelineError(UNBOUNDED_COST)


def where_clause(start: datetime | None = None, end: datetime | None = None) -> str:
    """The `$where` for a window. Always pedestrian, always bounded.

    The travel-mode clause is not optional and is not built by concatenation
    from a caller-supplied fragment: a window that did not restrict travelmode
    would pull bike rows into a pedestrian aggregate.
    """
    if start is None and end is None:
        refuse_unbounded()
    if start is None or end is None:
        raise C.PipelineError(
            f"a window needs both ends: start={start!r} end={end!r}. {UNBOUNDED_COST}"
        )
    if end <= start:
        raise C.PipelineError(f"window end {to_source_iso(end)} is not after start {to_source_iso(start)}")
    parts = [f"travelmode='{TRAVEL_MODE}'", f"timestamp >= '{to_source_iso(start)}'"]
    parts.append(f"timestamp < '{to_source_iso(end)}'")
    return " AND ".join(parts)


def has_pedestrian_filter(where: str) -> bool:
    return f"travelmode='{TRAVEL_MODE}'" in where


def select_clause() -> str:
    return ",".join(COUNT_COLUMNS)


def page_url(where: str, *, offset: int = 0, limit: int = C.FETCH_LIMIT) -> str:
    if offset < 0 or offset > C.MAX_SOCRATA_OFFSET:
        raise C.PipelineError(
            f"offset {offset} is outside 0..{C.MAX_SOCRATA_OFFSET} (Socrata's ceiling for this endpoint)"
        )
    params = {
        "$select": select_clause(),
        "$where": where,
        "$order": "timestamp,sensor_id,direction",
        "$limit": str(limit),
        "$offset": str(offset),
    }
    return C.resource_url(C.COUNTS_DATASET_ID, params)


def count_url(where: str) -> str:
    return C.resource_url(
        C.COUNTS_DATASET_ID, {"$select": "count(*) as n", "$where": where, "$limit": "1"}
    )


def fetch_view_meta() -> dict:
    """`rowsUpdatedAt` for the counts view, so the meta can say when the city last wrote."""
    url = C.view_url(C.COUNTS_DATASET_ID)
    meta, _ = C.http_get_json(url, what="dataset metadata")
    if not isinstance(meta, dict) or meta.get("id") != C.COUNTS_DATASET_ID:
        raise C.FetchError(f"{url}: expected the view for {C.COUNTS_DATASET_ID!r}")
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


def estimate_row_count(where: str) -> int:
    """`count(*)` for the window. One cheap row, and the only honest way to
    know a window's size before committing to it."""
    if not has_pedestrian_filter(where):
        raise C.PipelineError(f"refusing to count an unfiltered window: {where!r}")
    payload, _ = C.http_get_json(count_url(where), what=f"{C.COUNTS_DATASET_ID} count")
    rows = _as_rows(payload, "row count")
    if not rows or not str(rows[0].get("n", "")).isdigit():
        raise C.FetchError(f"could not read a row count from {rows!r}")
    return int(rows[0]["n"])


def check_window_budget(where: str, estimated: int, max_rows: int = C.MAX_SOCRATA_OFFSET) -> None:
    """Refuse a window that cannot be paged, with the arithmetic in the message.

    Socrata errors past `$offset` 43,043. Stopping there would leave the tail
    of the window missing, and a baseline built from the head of a window is a
    baseline built from a biased subset — a confidently wrong map rather than
    an obviously absent one.
    """
    if max_rows > C.MAX_SOCRATA_OFFSET:
        raise C.PipelineError(
            f"--max-rows {max_rows} is above Socrata's {C.MAX_SOCRATA_OFFSET}-row offset ceiling; "
            "a higher number cannot be paged and would truncate silently"
        )
    if estimated <= max_rows:
        return
    raise C.PipelineError(
        f"this window holds {estimated:,} rows, over the {max_rows:,}-row ceiling "
        f"(Socrata refuses $offset above {C.MAX_SOCRATA_OFFSET}). Narrow it: fewer days, a later "
        "--since, or split the range by hand. Refusing rather than truncating, because a "
        "partial window would build a baseline from a biased subset."
    )


# --------------------------------------------------------------------------- window


@dataclass(frozen=True)
class Window:
    start: datetime
    end: datetime
    reason: str

    @property
    def days(self) -> float:
        return (self.end - self.start).total_seconds() / 86400.0


def resolve_window(
    *,
    now: datetime,
    since: str | None = None,
    latest: bool = False,
    baseline_window_days: int = DEFAULT_BASELINE_WINDOW_DAYS,
    watermark: str | None = None,
) -> Window:
    """The window this run should fetch. Always bounded; never None.

    `--latest` and `--since` are explicit and win. The default is the
    incremental one: start just before the previous newest row so no interval
    is skipped, or `baseline_window_days` back when there is no previous run to
    resume from.
    """
    end = now.astimezone(C.NYC_TZ)
    if latest:
        return Window(end - timedelta(hours=LATEST_INTERVAL_HOURS), end, "latest interval")
    if since is not None:
        start = parse_date_bound(since)
        if start >= end:
            raise C.PipelineError(f"--since {since} is not in the past")
        return Window(start, end, f"since {since}")
    resume = parse_source_bound(watermark) if watermark else None
    if resume is not None:
        start = resume - timedelta(minutes=OVERLAP_MINUTES)
        return Window(start, end, "incremental from watermark")
    if baseline_window_days <= 0:
        raise C.PipelineError(f"--baseline-window must be positive, got {baseline_window_days}")
    return Window(
        end - timedelta(days=baseline_window_days),
        end,
        f"first run: {baseline_window_days}d baseline window",
    )


def parse_date_bound(value: str) -> datetime:
    """`--since` as a civil-time instant. `--since 2026-08-01` means midnight
    on 1 August as a New Yorker reads the clock, not midnight UTC."""
    text = str(value).strip()
    for pattern in ("%Y-%m-%dT%H:%M:%S", "%Y-%m-%dT%H:%M", "%Y-%m-%d"):
        try:
            return datetime.strptime(text, pattern).replace(tzinfo=C.NYC_TZ)
        except ValueError:
            continue
    raise C.PipelineError(
        f"could not read {value!r} as a date; use YYYY-MM-DD or YYYY-MM-DDTHH:MM:SS "
        "(interpreted in New York civil time, not in UTC and not in a fixed EST frame)"
    )


def parse_source_bound(value: str | None) -> datetime | None:
    if not value:
        return None
    text = str(value).strip().replace("Z", "+00:00")
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        # The watermark is stored by `to_source_iso`, i.e. as a civil wall clock.
        parsed = parsed.replace(tzinfo=C.NYC_TZ)
    return parsed.astimezone(C.NYC_TZ)


# --------------------------------------------------------------------------- merge


def row_key(row: dict) -> tuple:
    return tuple(str(row.get(column) or "") for column in ROW_KEY)


def merge_rows(previous: Iterable[dict], fetched: Iterable[dict]) -> tuple[list[dict], int]:
    """Union two row sets on the natural key. Returns (rows, duplicates_dropped)."""
    merged: dict[tuple, dict] = {}
    duplicates = 0
    for row in list(previous) + list(fetched):
        key = row_key(row)
        if key in merged:
            duplicates += 1
            continue
        merged[key] = row
    return canonical_rows(list(merged.values())), duplicates


def canonical_rows(rows: list[dict]) -> list[dict]:
    return sorted(rows, key=lambda row: (str(row.get("timestamp") or ""), row_key(row)))


def prune_to_window(rows: Iterable[dict], keep_from: datetime) -> list[dict]:
    """Drop rows older than the retained baseline window.

    Retention is bounded in days rather than in rows, because the number of
    rows a day depends on how many counters are alive and that changes.
    """
    kept = []
    dropped = 0
    for row in rows:
        moment = C.parse_source_timestamp(row.get("timestamp"))
        if moment is None or moment < keep_from:
            dropped += 1
            continue
        kept.append(row)
    if dropped:
        print(f"  pruned {dropped:,} row(s) older than {to_source_iso(keep_from)}")
    return canonical_rows(kept)


def newest_timestamp(rows: Iterable[dict]) -> datetime | None:
    moments = [
        moment
        for moment in (C.parse_source_timestamp(row.get("timestamp")) for row in rows)
        if moment is not None
    ]
    return max(moments) if moments else None


# --------------------------------------------------------------------------- extent

#: One cheap group-by over the WHOLE pedestrian subset: 8 rows, no window. It is
#: the only way to learn when a counter that stopped reporting last reported,
#: without fetching a window long enough to contain it — and its `sum(counts)`
#: is the doubled figure, because it sums both twins of each physical counter.
EXTENT_QUERY = (
    "sensor_id,count(*) as rows,sum(counts) as sumCounts,"
    "min(timestamp) as firstObservation,max(timestamp) as lastObservation"
)


def extent_url() -> str:
    return C.resource_url(
        C.COUNTS_DATASET_ID,
        {
            "$select": EXTENT_QUERY,
            "$where": f"travelmode='{TRAVEL_MODE}'",
            "$group": "sensor_id",
            "$order": "sensor_id",
            "$limit": "1000",
        },
    )


def fetch_extent() -> list[dict]:
    payload, _ = C.http_get_json(extent_url(), what="pedestrian sensor extent")
    return _as_rows(payload, "extent")


def twin_groups_from_extent(extent: list[dict]) -> list[list[str]]:
    """Sensor ids the source published identically, from the server's own totals.

    Two sensor ids with the same row count, the same sum, the same first and
    the same last observation are the same physical counter published twice.
    This is recorded, not acted on: `build_sensors.py` is what collapses them,
    and it does it from the counter serial in 6up2-gnw8, not from this guess.
    """
    buckets: dict[tuple, list[str]] = {}
    for row in extent:
        key = (
            str(row.get("rows")),
            str(row.get("sumCounts")),
            str(row.get("firstObservation")),
            str(row.get("lastObservation")),
        )
        identifier = C.normalise_text(row.get("sensor_id"))
        if identifier is not None:
            buckets.setdefault(key, []).append(identifier)
    return sorted(
        [sorted(members) for members in buckets.values() if len(members) > 1],
        key=lambda members: members[0],
    )


# --------------------------------------------------------------------------- run


def fetch_window(where: str, *, max_rows: int = C.MAX_SOCRATA_OFFSET, what: str = "rows") -> list[dict]:
    """Page a window. The budget has already been checked by the caller."""
    rows: list[dict] = []
    for offset in range(0, max_rows, C.FETCH_LIMIT):
        limit = min(C.FETCH_LIMIT, max_rows - offset)
        payload, _ = C.http_get_json(page_url(where, offset=offset, limit=limit), what=what)
        page = _as_rows(payload, what)
        rows.extend(page)
        print(f"  {offset:,}..{offset + len(page):,} rows ({len(rows):,} total)")
        if len(page) < limit:
            break
    return rows


def build_fetch_meta(
    *,
    rows: list[dict],
    where: str,
    window: Window,
    view_meta: dict | None,
    extent: list[dict],
    fetched: int,
    duplicates: int,
    pruned: int,
    previous_rows: int,
    baseline_window_days: int,
) -> dict:
    newest = newest_timestamp(rows)
    oldest = min(
        (m for m in (C.parse_source_timestamp(r.get("timestamp")) for r in rows) if m is not None),
        default=None,
    )
    doubled = sum(C.parse_count(row.get("sumCounts")) or 0 for row in extent)
    twin_groups = twin_groups_from_extent(extent)
    covered = sum(1 for members in twin_groups for _ in members)
    return {
        "dataset": C.COUNTS_NAME,
        "datasetId": C.COUNTS_DATASET_ID,
        "url": page_url(where),
        "retrieved_at": C.iso_now(),
        "windowReason": window.reason,
        "windowStart": to_source_iso(window.start),
        "windowEnd": to_source_iso(window.end),
        "windowDays": round_half_up(window.days),
        "baselineWindowDays": baseline_window_days,
        "where": where,
        "select": select_clause(),
        "order": "timestamp,sensor_id,direction",
        "pageSize": C.FETCH_LIMIT,
        "maxOffset": C.MAX_SOCRATA_OFFSET,
        "travelMode": TRAVEL_MODE,
        "windowRows": fetched,
        "rowCount": len(rows),
        "previousRows": previous_rows,
        "duplicatesCollapsed": duplicates,
        "prunedRows": pruned,
        "contentHash": C.sha256_hex(C.canonical_json(rows).encode("utf-8")),
        "watermark": to_source_iso(newest) if newest else None,
        "watermarkUtc": C.iso_utc(newest) if newest else None,
        "windowFirst": to_source_iso(oldest) if oldest else None,
        "rowsUpdatedAt": (view_meta or {}).get("rowsUpdatedAt"),
        "sourceUpdatedAt": C.epoch_to_iso((view_meta or {}).get("rowsUpdatedAt")),
        "sensorExtent": extent,
        "twinGroups": twin_groups,
        "pedestrianTotals": {
            "sourceRows": sum(C.parse_count(row.get("rows")) or 0 for row in extent),
            "sumCountsTwinDoubled": doubled,
            "sumCountsPhysical": doubled // 2 if doubled and covered == len(extent) else None,
            "twinGroups": len(twin_groups),
        },
    }


def run(
    *,
    raw_path: Path | None = None,
    meta_path: Path | None = None,
    since: str | None = None,
    latest: bool = False,
    baseline_window_days: int = DEFAULT_BASELINE_WINDOW_DAYS,
    max_rows: int = C.MAX_SOCRATA_OFFSET,
    budget: bool = True,
    now: datetime | None = None,
    extent: list[dict] | None = None,
) -> dict:
    target = raw_path or C.COUNTS_RAW_PATH
    meta_target = meta_path or C.COUNTS_META_PATH
    previous_meta = C.read_fetch_meta(meta_target)
    watermark = (previous_meta or {}).get("watermark")
    previous_rows: list[dict] = []
    if target.exists():
        previous_rows = C.load_raw_rows(target)

    window = resolve_window(
        now=now or source_now(),
        since=since,
        latest=latest,
        baseline_window_days=baseline_window_days,
        watermark=watermark,
    )
    where = where_clause(window.start, window.end)
    print(f"window         {to_source_iso(window.start)} .. {to_source_iso(window.end)}  ({window.reason})")
    print(f"$where         {where}")

    estimated = estimate_row_count(where)
    print(f"rows in window {estimated:,} (ceiling {max_rows:,})")
    if budget:
        check_window_budget(where, estimated, max_rows)

    fetched = fetch_window(where, max_rows=min(max_rows, max(estimated, 1)))
    if not fetched:
        raise C.FetchError(
            f"the window held no {TRAVEL_MODE} rows; refusing to overwrite the snapshot"
        )
    if len(fetched) != estimated:
        raise C.FetchError(
            f"count(*) said {estimated} rows but the pages returned {len(fetched)}; "
            "refusing to write a snapshot that does not match the source"
        )

    merged, duplicates = merge_rows(previous_rows, fetched)
    keep_from = (now or source_now()).astimezone(C.NYC_TZ) - timedelta(
        days=baseline_window_days
    )
    retained = prune_to_window(merged, keep_from)
    if not retained:
        raise C.FetchError("every row fell outside the retention window; refusing to write nothing")

    meta = build_fetch_meta(
        rows=retained,
        where=where,
        window=window,
        view_meta=fetch_view_meta(),
        extent=extent if extent is not None else fetch_extent(),
        fetched=len(fetched),
        duplicates=duplicates,
        pruned=len(merged) - len(retained),
        previous_rows=len(previous_rows),
        baseline_window_days=baseline_window_days,
    )
    C.write_json_file(target, retained)
    C.write_json_file(meta_target, meta)

    print(f"window rows    {len(fetched):,}")
    print(
        f"snapshot rows  {len(retained):,} (was {len(previous_rows):,},"
        f" {len(fetched) - duplicates:,} new,"
        f" {duplicates:,} already present and collapsed on (sensor_id,direction,timestamp),"
        f" -{meta['prunedRows']:,} pruned)"
    )
    print(f"watermark      {meta['watermark']} ({meta['watermarkUtc']})")
    print(f"pedestrian     {meta['pedestrianTotals']['sourceRows']:,} rows all-time,"
          f" twin-doubled sum {meta['pedestrianTotals']['sumCountsTwinDoubled']:,},"
          f" physical {meta['pedestrianTotals']['sumCountsPhysical']:,}")
    for members in meta["twinGroups"]:
        print(f"  twin         {' + '.join(members)}")
    print(f"contentHash    {meta['contentHash']}")
    print(f"wrote          {C.display_path(target)}")
    print(f"wrote          {C.display_path(meta_target)}")
    return meta


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    group = parser.add_mutually_exclusive_group()
    group.add_argument("--latest", action="store_true", help="fetch only the most recent interval")
    group.add_argument("--since", default=None, metavar="YYYY-MM-DD", help="resume from a date")
    parser.add_argument(
        "--all",
        action="store_true",
        help="refused: this dataset is never fetched whole (see the message)",
    )
    parser.add_argument(
        "--baseline-window",
        dest="baseline_window_days",
        type=int,
        default=DEFAULT_BASELINE_WINDOW_DAYS,
        help=f"days of history to retain ({DEFAULT_BASELINE_WINDOW_DAYS} = 8 samples per weekday/bucket)",
    )
    parser.add_argument(
        "--max-rows",
        type=int,
        default=C.MAX_SOCRATA_OFFSET,
        help=f"per-fetch row ceiling, capped at Socrata's {C.MAX_SOCRATA_OFFSET} offset limit",
    )
    parser.add_argument("--no-budget-check", action="store_true", help="skip the pre-flight count")
    parser.add_argument("--raw", type=Path, default=None, help="raw snapshot to write")
    parser.add_argument("--meta", type=Path, default=None, help="fetch-meta sidecar to write")
    args = parser.parse_args(argv)

    if args.all:
        print(f"fetch_counts: --all refused. {UNBOUNDED_COST}", file=sys.stderr)
        return 2
    try:
        run(
            raw_path=args.raw,
            meta_path=args.meta,
            since=args.since,
            latest=args.latest,
            baseline_window_days=args.baseline_window_days,
            max_rows=args.max_rows,
            budget=not args.no_budget_check,
        )
    except C.PipelineError as exc:
        print(f"fetch_counts: {exc}", file=sys.stderr)
        return 1
    except KeyboardInterrupt:  # pragma: no cover
        print("fetch_counts: interrupted", file=sys.stderr)
        return 130
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
