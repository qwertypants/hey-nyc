#!/usr/bin/env python3
"""Developer exploration tool for the raw snapshot.

Answers every question docs/data-dictionary.md claims to have measured, and
re-measures them, so a schema change shows up as a number rather than a surprise
in the app. Read-only: it never writes the published artifacts.

Usage:
    python3 scripts/inspect_data.py [--json] [--samples N] [--raw PATH]
"""

from __future__ import annotations

import argparse
import collections
import json
import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))

import _common as C  # noqa: E402

CATEGORICAL_COLUMNS = ("license_type", "license_status", "borough", "city")
SAMPLE_COLUMNS = (
    ":id",
    "business_legal_name",
    "assumed_name_s",
    "street",
    "city",
    "borough",
    "postcode",
    "license_type",
    "license_status",
    "license_issue_date",
    "license_expiration_date",
    "latitude",
    "longitude",
    "bbl",
    "nta2020",
)


def _safe(label: str, fn, out: dict) -> Any:
    """A section must never take the whole report down."""
    try:
        return fn()
    except Exception as exc:  # noqa: BLE001 - exploration tool, keep going
        out.setdefault("errors", {})[label] = f"{type(exc).__name__}: {exc}"
        return None


def column_profile(rows: list[dict]) -> list[dict]:
    seen: set[str] = set()
    for row in rows:
        seen.update(row.keys())
    profile = []
    for column in sorted(seen):
        present = sum(1 for row in rows if row.get(column) not in (None, ""))
        profile.append(
            {
                "column": column,
                "present": present,
                "null": len(rows) - present,
                "distinct": len({C.canonical_json(row.get(column)) for row in rows}),
            }
        )
    return profile


def categorical_profile(rows: list[dict]) -> dict[str, list[dict]]:
    out: dict[str, list[dict]] = {}
    for column in CATEGORICAL_COLUMNS:
        counter: collections.Counter[str] = collections.Counter()
        for row in rows:
            value = C.normalise_text(row.get(column))
            counter["<null>" if value is None else value] += 1
        out[column] = [
            {"value": value, "count": count}
            for value, count in sorted(counter.items(), key=lambda kv: (-kv[1], kv[0]))
        ]
    return out


def coordinate_profile(rows: list[dict]) -> dict:
    lats: list[float] = []
    lons: list[float] = []
    unparseable: list[dict] = []
    out_of_bounds: list[dict] = []
    for row in rows:
        lat, lon, failure = C.coordinates_of(row)
        if failure or lat is None or lon is None:
            unparseable.append(_label(row))
            continue
        lats.append(lat)
        lons.append(lon)
        if not C.in_nyc_bbox(lat, lon):
            out_of_bounds.append({**_label(row), "latitude": lat, "longitude": lon})
    return {
        "latMin": min(lats) if lats else None,
        "latMax": max(lats) if lats else None,
        "lngMin": min(lons) if lons else None,
        "lngMax": max(lons) if lons else None,
        "bbox": {"lat": [C.LAT_MIN, C.LAT_MAX], "lng": [C.LNG_MIN, C.LNG_MAX]},
        "inBounds": len(lats) - len(out_of_bounds),
        "unparseable": unparseable,
        "outOfBounds": out_of_bounds,
    }


def postcode_profile(rows: list[dict]) -> dict:
    lengths: collections.Counter[str] = collections.Counter()
    non_digits: list[str] = []
    leading_zero: list[str] = []
    distinct: set[str] = set()
    for row in rows:
        value = C.normalise_text(row.get("postcode"))
        if value is None:
            lengths["<null>"] += 1
            continue
        distinct.add(value)
        lengths[str(len(value))] += 1
        if not value.isdigit():
            non_digits.append(value)
        elif value.startswith("0"):
            leading_zero.append(value)
    return {
        "distinct": len(distinct),
        "lengthHistogram": dict(sorted(lengths.items())),
        "nonNumeric": sorted(set(non_digits)),
        "leadingZeroValues": sorted(set(leading_zero)),
        "anomalies": sorted(
            {v for v in distinct if not v.isdigit() or len(v) != 5}
        ),
    }


def bbl_profile(rows: list[dict]) -> dict:
    degenerate: collections.Counter[str] = collections.Counter()
    lengths: collections.Counter[str] = collections.Counter()
    null = 0
    short_but_plausible: list[dict] = []
    for row in rows:
        raw = C.normalise_text(row.get("bbl"))
        value, _degenerate = C.normalise_bbl(row.get("bbl"))
        if value is None:
            if raw is None:
                null += 1
            else:
                degenerate[raw] += 1
            continue
        lengths[str(len(value))] += 1
        if len(value) < C.BBL_CANONICAL_DIGITS:
            short_but_plausible.append({**_label(row), "bbl": value, "length": len(value)})
    return {
        "null": null,
        "degenerate": [
            {"value": value, "count": count}
            for value, count in sorted(degenerate.items(), key=lambda kv: (-kv[1], kv[0]))
        ],
        "degenerateTotal": sum(degenerate.values()),
        "lengthHistogram": dict(sorted(lengths.items())),
        "canonicalDigits": C.BBL_CANONICAL_DIGITS,
        "shortButPlausible": short_but_plausible,
    }


def group_profile(rows: list[dict]) -> dict:
    groups: dict[tuple[str | None, str | None], list[dict]] = collections.defaultdict(list)
    for row in rows:
        key = (C.normalise_text(row.get("business_legal_name")), C.normalise_text(row.get("street")))
        groups[key].append(row)
    sizes: collections.Counter[str] = collections.Counter()
    sidewalk_and_roadway = 0
    same_type_pairs = 0
    three_plus = 0
    coordinate_disagreements = 0
    identical_coordinates = 0
    unknown_type_groups = 0
    for members in groups.values():
        sizes[str(len(members))] += 1
        types = {C.normalise_text(m.get("license_type")) for m in members}
        if len(members) >= 3:
            three_plus += 1
        if any(t not in C.LICENSE_TYPE_TO_DINING for t in types):
            unknown_type_groups += 1
        if len(members) == 2:
            if types == C.BOTH_PAIR:
                sidewalk_and_roadway += 1
            elif len(types) == 1:
                same_type_pairs += 1
        coords = {
            (C.normalise_text(m.get("latitude")), C.normalise_text(m.get("longitude")))
            for m in members
        }
        if len(coords) > 1:
            coordinate_disagreements += 1
        elif len(members) > 1:
            identical_coordinates += 1
    return {
        "groups": len(groups),
        "sizeHistogram": dict(sorted(sizes.items(), key=lambda kv: int(kv[0]))),
        "sidewalkAndRoadwayPairs": sidewalk_and_roadway,
        "sameTypePairs": same_type_pairs,
        "threePlusGroups": three_plus,
        "coordinateDisagreements": coordinate_disagreements,
        "groupsWithIdenticalCoordinates": identical_coordinates,
        "groupsWithUnknownLicenseType": unknown_type_groups,
    }


def rejection_profile(rows: list[dict]) -> dict:
    counter: collections.Counter[str] = collections.Counter()
    samples: dict[str, list[dict]] = collections.defaultdict(list)
    for row in rows:
        lat, lon, failure = C.coordinates_of(row)
        codes: list[str] = []
        if failure:
            codes.append(failure)
        elif lat is None or lon is None:
            codes.append("missing_coordinates")
        else:
            if not C.in_nyc_bbox(lat, lon):
                codes.append("out_of_bounds")
            if C.normalise_text(row.get("borough")) not in C.BOROUGHS:
                codes.append("unknown_borough")
        if not codes:
            continue
        code = next((c for c in C.REJECTION_CODES if c in codes), codes[0])
        counter[code] += 1
        samples[code].append(
            {
                **_label(row),
                "latitude": lat,
                "longitude": lon,
                "alsoFailed": [c for c in codes if c != code],
            }
        )
    return {
        "total": sum(counter.values()),
        "byReason": {code: counter.get(code, 0) for code in C.REJECTION_CODES if counter.get(code)},
        "keptRows": len(rows) - sum(counter.values()),
        "samples": dict(samples),
    }


def _label(row: dict) -> dict:
    return {
        "name": C.normalise_text(row.get("assumed_name_s"))
        or C.normalise_text(row.get("business_legal_name")),
        "legalName": C.normalise_text(row.get("business_legal_name")),
        "street": C.normalise_text(row.get("street")),
        "city": C.normalise_text(row.get("city")),
        "borough": C.normalise_text(row.get("borough")),
        "zip": C.normalise_text(row.get("postcode")),
        "licenseType": C.normalise_text(row.get("license_type")),
        "sid": C.normalise_text(row.get(":id")),
    }


def build_report(rows: list[dict], meta: dict | None = None, samples: int = 2) -> dict:
    out: dict[str, Any] = {
        "source": C.RESOURCE_URL,
        "datasetId": C.DATASET_ID,
        "rowCount": len(rows),
        "fetchMeta": meta,
    }
    out["columns"] = _safe("columns", lambda: column_profile(rows), out)
    out["categorical"] = _safe("categorical", lambda: categorical_profile(rows), out)
    out["coordinates"] = _safe("coordinates", lambda: coordinate_profile(rows), out)
    out["postcode"] = _safe("postcode", lambda: postcode_profile(rows), out)
    out["bbl"] = _safe("bbl", lambda: bbl_profile(rows), out)
    out["groups"] = _safe("groups", lambda: group_profile(rows), out)
    out["rejections"] = _safe("rejections", lambda: rejection_profile(rows), out)
    out["samples"] = _safe(
        "samples",
        lambda: [
            {k: row.get(k) for k in SAMPLE_COLUMNS} for row in rows[: max(0, samples)]
        ],
        out,
    )
    out["expected"] = {
        "rowCount": 2437,
        "rejected": 6,
        "keptRows": 2431,
        "publishedLocations": 2000,
        "types": {"sidewalk": 1173, "roadway": 396, "both": 431},
    }
    return out


# --------------------------------------------------------------------------- text


def _table(rows: list[list[Any]], headers: list[str]) -> list[str]:
    widths = [len(h) for h in headers]
    for row in rows:
        for i, cell in enumerate(row):
            widths[i] = max(widths[i], len(str(cell)))
    out = ["  " + "  ".join(h.ljust(widths[i]) for i, h in enumerate(headers))]
    for row in rows:
        out.append("  " + "  ".join(str(c).ljust(widths[i]) for i, c in enumerate(row)))
    return out


def format_report(report: dict) -> str:
    lines: list[str] = []
    add = lines.append
    add(f"dataset        {report['datasetId']}  ({C.DATASET_NAME})")
    add(f"source         {report['source']}")
    meta = report.get("fetchMeta")
    if meta:
        add(
            f"fetched        {meta.get('retrieved_at')}  rows={meta.get('rowCount')}"
            f"  sha256={str(meta.get('responseSha256'))[:16]}..."
        )
        add(f"rowsUpdatedAt  {meta.get('rowsUpdatedAt')}  ({meta.get('sourceUpdatedAt')})")
    add(f"rows           {report['rowCount']}")
    add(f"expected       {report['expected']['rowCount']} (2026-09-27 measurement)")

    if report.get("columns") is not None:
        add("")
        add("COLUMNS")
        lines.extend(
            _table(
                [[c["column"], c["present"], c["null"], c["distinct"]] for c in report["columns"]],
                ["column", "present", "null", "distinct"],
            )
        )

    if report.get("categorical") is not None:
        add("")
        add("CATEGORICAL VALUES")
        for column, values in report["categorical"].items():
            add(f"  {column} ({len(values)} distinct)")
            lines.extend(
                _table([[v["value"], v["count"]] for v in values], ["value", "count"])
            )

    coords = report.get("coordinates")
    if coords is not None:
        add("")
        add("COORDINATES")
        add(
            f"  observed  lat [{coords['latMin']}, {coords['latMax']}]"
            f"  lng [{coords['lngMin']}, {coords['lngMax']}]"
        )
        add(
            f"  bbox      lat [{C.LAT_MIN}, {C.LAT_MAX}]  lng [{C.LNG_MIN}, {C.LNG_MAX}]"
        )
        add(f"  in bounds {coords['inBounds']}   out of bounds {len(coords['outOfBounds'])}"
            f"   unparseable {len(coords['unparseable'])}")
        for row in coords["outOfBounds"]:
            add(
                f"    ! {row['legalName']} / {row['street']} / borough={row['borough']}"
                f" / {row['latitude']},{row['longitude']}"
            )

    pc = report.get("postcode")
    if pc is not None:
        add("")
        add("POSTCODE")
        add(f"  distinct {pc['distinct']}   length histogram {pc['lengthHistogram']}")
        add(f"  leading-zero values {pc['leadingZeroValues'] or 'none'}")
        add(f"  anomalies (not 5 digits) {pc['anomalies'] or 'none'}")

    bbl = report.get("bbl")
    if bbl is not None:
        add("")
        add("BBL")
        add(f"  null {bbl['null']}   degenerate {bbl['degenerateTotal']} {bbl['degenerate']}")
        add(f"  length histogram {bbl['lengthHistogram']}")
        for row in bbl["shortButPlausible"]:
            add(
                f"    ! kept {row['bbl']} ({row['length']} of {bbl['canonicalDigits']} digits)"
                f" for {row['legalName']} / {row['street']}"
            )

    groups = report.get("groups")
    if groups is not None:
        add("")
        add("GROUPS BY (business_legal_name, street)")
        add(f"  groups {groups['groups']}   size histogram {groups['sizeHistogram']}")
        add(f"  Sidewalk+Roadway pairs {groups['sidewalkAndRoadwayPairs']}")
        add(f"  same-license_type pairs {groups['sameTypePairs']}")
        add(f"  3+ row groups {groups['threePlusGroups']}")
        add(f"  coordinate disagreements {groups['coordinateDisagreements']}")
        add(f"  groups with byte-identical coordinates {groups['groupsWithIdenticalCoordinates']}")

    rej = report.get("rejections")
    if rej is not None:
        add("")
        add("ROWS THAT clean_data.py WOULD REJECT")
        add(f"  total {rej['total']}   kept {rej['keptRows']}")
        for code, count in rej["byReason"].items():
            add(f"  {code:26} {count}")
        for code, rows in rej["samples"].items():
            for row in rows:
                extra = f"  (also {', '.join(row['alsoFailed'])})" if row["alsoFailed"] else ""
                add(
                    f"    - {code}: {row['legalName']} / {row['street']}"
                    f" / city={row['city']} borough={row['borough']} zip={row['zip']}{extra}"
                )

    if report.get("samples"):
        add("")
        add("SAMPLE ROWS")
        for sample in report["samples"]:
            add(f"  {C.canonical_json(sample)}")

    if report.get("errors"):
        add("")
        add("SECTION ERRORS (inspection is incomplete)")
        for label, message in report["errors"].items():
            add(f"  ! {label}: {message}")

    return "\n".join(lines)


def format_summary(report: dict) -> str:
    """Condensed form used by refresh_data.py."""
    lines = [
        f"  rows {report['rowCount']} (expected {report['expected']['rowCount']})"
        f"  columns {len(report.get('columns') or [])}"
    ]
    categorical = report.get("categorical") or {}
    for column, values in categorical.items():
        shown = ", ".join(f"{v['value']}={v['count']}" for v in values[:4])
        more = f" (+{len(values) - 4} more)" if len(values) > 4 else ""
        lines.append(f"  {column}: {shown}{more}")
    coords = report.get("coordinates") or {}
    lines.append(
        f"  lat [{coords.get('latMin')}, {coords.get('latMax')}]"
        f"  lng [{coords.get('lngMin')}, {coords.get('lngMax')}]"
        f"  out-of-bounds {len(coords.get('outOfBounds') or [])}"
    )
    bbl = report.get("bbl") or {}
    lines.append(f"  degenerate bbl {bbl.get('degenerateTotal')}   null bbl {bbl.get('null')}")
    groups = report.get("groups") or {}
    lines.append(
        f"  groups {groups.get('groups')} sizes {groups.get('sizeHistogram')}"
        f"  sidewalk+roadway pairs {groups.get('sidewalkAndRoadwayPairs')}"
    )
    rej = report.get("rejections") or {}
    lines.append(f"  would reject {rej.get('total')} -> {rej.get('byReason')}")
    outliers: dict[tuple, dict] = {}
    for row in (coords.get("outOfBounds") or []):
        outliers.setdefault((row.get("legalName"), row.get("street")), row)
    for row in outliers.values():
        lines.append(
            f"    ! out of bbox: {row['legalName']} / {row['street']}"
            f" @ {row['latitude']},{row['longitude']}"
            + (f" x2 (one row per licence)" if rej.get("byReason", {}).get("out_of_bounds", 0) > 1 else "")
        )
    if report.get("errors"):
        lines.append(f"  section errors: {report['errors']}")
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--json", action="store_true", help="emit the report as JSON")
    parser.add_argument("--samples", type=int, default=2, help="how many raw rows to print")
    parser.add_argument(
        "--raw", type=Path, default=None, help="raw snapshot to read (default data/raw)"
    )
    args = parser.parse_args(argv)

    try:
        rows = C.load_raw_rows(args.raw)
    except C.PipelineError as exc:
        if args.raw is not None or not C.RAW_DATA_PATH.exists():
            print(f"inspect_data: {exc}", file=sys.stderr)
            return 1
        # Convenience only, and never silent: say out loud that we are fetching.
        print(f"inspect_data: {exc} — fetching first", file=sys.stderr)
        import fetch_data  # noqa: PLC0415

        if fetch_data.run() != 0:
            return 1
        rows = C.load_raw_rows(args.raw)

    report = build_report(rows, meta=C.load_fetch_meta(), samples=args.samples)
    if args.json:
        print(json.dumps(report, indent=2, sort_keys=True, ensure_ascii=False))
    else:
        print(format_report(report))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
