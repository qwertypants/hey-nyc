#!/usr/bin/env python3
"""One maintainer command for the Where NYC Walks sensor pipeline.

    sensors fetch -> counts fetch (incremental) -> build -> validate

Same shape as scripts/refresh_data.py, same kind of report, same stop-at-the-
first-failure behaviour. It is safe to re-run: a refresh that finds no new rows
reproduces the published artifacts byte for byte, and this prints `unchanged`
rather than `updated` so you can see that at a glance.

`--offline` skips both fetch stages and rebuilds from the raw snapshots already
in data/raw/walk. That is what makes this testable and what CI can smoke-test:
no network, no flake, and it still exercises collapse, baseline, staleness and
every validator check.

Usage:
    python3 scripts/walk/refresh.py [--offline] [--dry-run] [--out-dir DIR] [--now ISO]
"""

from __future__ import annotations

import argparse
import importlib.util
import sys
import time
from pathlib import Path

if "walk_common" not in sys.modules:
    _spec = importlib.util.spec_from_file_location(
        "walk_common", Path(__file__).resolve().parent / "_common.py"
    )
    _walk_common = importlib.util.module_from_spec(_spec)
    sys.modules["walk_common"] = _walk_common
    _spec.loader.exec_module(_walk_common)
C = sys.modules["walk_common"]

sys.path.insert(0, str(Path(__file__).resolve().parent))

import build_sensors  # noqa: E402
import fetch_counts  # noqa: E402
import fetch_sensors  # noqa: E402
import validate_walk  # noqa: E402


class StageFailed(RuntimeError):
    pass


def banner(number: int, name: str, detail: str) -> None:
    print(f"\n[{number}/4] {name} — {detail}")


def stage_fetch_sensors(dry_run: bool) -> dict:
    banner(1, "fetch sensors", f"{C.SENSORS_DATASET_ID} (67 rows, fetched whole)")
    if dry_run:
        print("  dry run: not downloading")
        return {}
    return fetch_sensors.run()


def stage_fetch_counts(dry_run: bool, baseline_window_days: int) -> dict:
    banner(2, "fetch counts", f"{C.COUNTS_DATASET_ID} pedestrian, incremental")
    if dry_run:
        print("  dry run: not downloading")
        return {}
    return fetch_counts.run(baseline_window_days=baseline_window_days)


def stage_build(
    out_dir: Path | None, now: str | None, dry_run: bool, args_quiet: bool
) -> build_sensors.Outcome:
    banner(3, "build", "sensors.geojson + latest.json")
    outcome = build_sensors.run(now=now, out_dir=out_dir, quiet=True, write_files=not dry_run)
    if not args_quiet:
        print(build_sensors.format_summary(outcome))
    return outcome


def stage_validate(
    out_dir: Path | None,
    strict: bool,
    outcome: build_sensors.Outcome | None,
    min_sensors: int,
) -> None:
    banner(4, "validate", "artifacts vs src/types/walk.ts")
    if outcome is not None:
        # In-memory, so a dry run is validated as well as reported.
        result = validate_walk.validate(
            geojson=outcome.geojson(),
            latest=outcome.latest,
            count_rows=C.load_raw_rows(C.COUNTS_RAW_PATH) if C.COUNTS_RAW_PATH.exists() else None,
            sensor_rows=C.load_raw_rows(C.SENSORS_RAW_PATH) if C.SENSORS_RAW_PATH.exists() else None,
            min_sensors=min_sensors,
        )
    else:
        result = validate_walk.validate_paths(out_dir=out_dir, min_sensors=min_sensors)
    print(validate_walk.format_result(result))
    if result.errors:
        raise StageFailed(f"{len(result.errors)} validation error(s)")
    if strict and result.warnings:
        raise StageFailed(f"--strict: {len(result.warnings)} warning(s)")


def _diff(path: Path, previous: bytes | None, payload: bytes) -> str:
    if previous is None:
        return "new"
    return "unchanged" if previous == payload else "updated"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument(
        "--offline", action="store_true", help="skip both fetches; build from data/raw/walk"
    )
    parser.add_argument("--dry-run", action="store_true", help="do everything, write nothing")
    parser.add_argument("--strict", action="store_true", help="treat drift warnings as a failure")
    parser.add_argument("--out-dir", type=Path, default=None, help="write artifacts here, not public/data/walk")
    parser.add_argument("--now", default=None, help="pin the clock (ISO-8601 UTC) for a reproducible build")
    parser.add_argument(
        "--baseline-window",
        dest="baseline_window_days",
        type=int,
        default=fetch_counts.DEFAULT_BASELINE_WINDOW_DAYS,
        help="days of history to fetch and retain",
    )
    parser.add_argument(
        "--min-sensors",
        type=int,
        default=validate_walk.MIN_SENSORS,
        help="fail below this published counter count (a real dataset has 4)",
    )
    parser.add_argument("--quiet", action="store_true", help="only print stage headers")
    args = parser.parse_args(argv)

    started = time.monotonic()
    print(f"where-nyc-walks sensor refresh  (datasets {C.SENSORS_DATASET_ID} + {C.COUNTS_DATASET_ID})")

    out_dir = None if args.dry_run else args.out_dir
    if args.dry_run and args.out_dir:
        print("  --dry-run and --out-dir together: nothing is written either way")

    # The historical half of this pipeline owns public/data/walk/, and two
    # processes writing the same directory in the same tree is how a half
    # written artifact set happens. `--out-dir` keeps this half's run isolated.
    targets = (
        [
            (args.out_dir or C.PUBLIC_DATA_DIR) / "sensors.geojson",
            (args.out_dir or C.PUBLIC_DATA_DIR) / "latest.json",
        ]
        if not args.dry_run
        else []
    )
    before = {path: (path.read_bytes() if path.exists() else None) for path in targets}

    try:
        if args.offline:
            banner(1, "fetch sensors", "skipped (--offline)")
            banner(2, "fetch counts", "skipped (--offline)")
            for path in (C.SENSORS_RAW_PATH, C.COUNTS_RAW_PATH):
                if not path.exists():
                    print(
                        f"refresh: --offline but {C.display_path(path)} does not exist; "
                        "run once without --offline first",
                        file=sys.stderr,
                    )
                    return 1
        else:
            stage_fetch_sensors(args.dry_run)
            stage_fetch_counts(args.dry_run, args.baseline_window_days)
        outcome = stage_build(out_dir, args.now, args.dry_run, args.quiet)
        stage_validate(out_dir, args.strict, outcome if args.dry_run else None, args.min_sensors)
    except StageFailed as exc:
        print(f"\nrefresh: STOPPED: {exc}", file=sys.stderr)
        return 1
    except C.PipelineError as exc:
        print(f"\nrefresh: STOPPED: {exc}", file=sys.stderr)
        return 1

    print("\nARTIFACTS")
    for path in targets:
        payload = C.compact_json(outcome.geojson() if path.name.endswith(".geojson") else outcome.latest)
        state = _diff(path, before[path], (payload + "\n").encode("utf-8"))
        size = path.stat().st_size if path.exists() else 0
        print(f"  {C.display_path(path):34} {size:>9,} bytes  {state}")
    print(f"\n  content hash  {outcome.report['sensors']['contentHash']}")
    print(f"refresh: ok in {time.monotonic() - started:.1f}s")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
