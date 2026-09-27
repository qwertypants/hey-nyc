#!/usr/bin/env python3
"""Run the whole data pipeline: fetch -> inspect -> clean -> validate.

Stops at the first failure and exits non-zero, so it is safe to use as a CI or
pre-commit step. Nothing here invents data: every stage is the same module that
`npm run data:*` runs on its own.

Usage:
    python3 scripts/refresh_data.py [--skip-fetch] [--strict] [--quiet]
"""

from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import _common as C  # noqa: E402
import clean_data  # noqa: E402
import fetch_data  # noqa: E402
import inspect_data  # noqa: E402
import validate_data  # noqa: E402


class StageFailed(RuntimeError):
    pass


def banner(number: int, name: str, detail: str) -> None:
    print(f"\n[{number}/4] {name} — {detail}")


def stage_fetch() -> None:
    banner(1, "fetch", f"NYC Open Data {C.DATASET_ID}")
    if fetch_data.run() != 0:
        raise StageFailed("fetch_data.py failed")


def stage_inspect() -> None:
    banner(2, "inspect", "raw snapshot profile")
    rows = C.load_raw_rows()
    report = inspect_data.build_report(rows, meta=C.load_fetch_meta(), samples=0)
    print(inspect_data.format_summary(report))
    print("  (full column-by-column dump: python3 scripts/inspect_data.py)")


def stage_clean() -> None:
    banner(3, "clean", "public/data + data/processed")
    print(clean_data.format_summary(clean_data.run(quiet=True)))


def stage_validate(strict: bool) -> None:
    banner(4, "validate", "artifacts vs src/types/location.ts")
    result = validate_data.validate()
    print(validate_data.format_result(result))
    if result.errors:
        raise StageFailed(f"{len(result.errors)} validation error(s)")
    if strict and result.warnings:
        raise StageFailed(f"--strict: {len(result.warnings)} schema-drift warning(s)")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument(
        "--skip-fetch", action="store_true", help="reuse data/raw instead of re-downloading"
    )
    parser.add_argument(
        "--strict", action="store_true", help="treat schema drift as a failure (for CI)"
    )
    parser.add_argument("--quiet", action="store_true", help="only print stage headers")
    args = parser.parse_args(argv)

    started = time.monotonic()
    stages = (
        ("fetch", lambda: None if args.skip_fetch else stage_fetch()),
        ("inspect", stage_inspect),
        ("clean", stage_clean),
        ("validate", lambda: stage_validate(args.strict)),
    )

    print(f"eat-outside-nyc data refresh  (dataset {C.DATASET_ID})")
    for name, run_stage in stages:
        if name == "fetch" and args.skip_fetch:
            banner(1, "fetch", f"skipped (--skip-fetch), reusing {C.display_path(C.RAW_DATA_PATH)}")
            if not C.RAW_DATA_PATH.exists():
                print(
                    f"refresh_data: --skip-fetch but {C.display_path(C.RAW_DATA_PATH)} does not exist",
                    file=sys.stderr,
                )
                return 1
            continue
        try:
            run_stage()
        except StageFailed as exc:
            print(f"\nrefresh_data: STOPPED at stage '{name}': {exc}", file=sys.stderr)
            return 1
        except C.PipelineError as exc:
            print(f"\nrefresh_data: STOPPED at stage '{name}': {exc}", file=sys.stderr)
            return 1

    if not args.quiet:
        print("\nARTIFACTS")
        for path in (C.GEOJSON_PATH, C.METADATA_PATH, C.REPORT_PATH):
            size = path.stat().st_size if path.exists() else 0
            print(f"  {C.display_path(path):32} {size:>9,} bytes")
    print(f"\nrefresh_data: ok in {time.monotonic() - started:.1f}s")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
