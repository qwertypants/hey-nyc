#!/usr/bin/env python3
"""Assert the published artifacts against the contract in src/types/location.ts.

Two failure classes, deliberately kept apart:

* **Corruption** — unparseable JSON, a non-Point geometry, a coordinate outside
  the bbox, a missing or duplicated id, counts that disagree between the three
  files, a collapsed record count. Always fatal.
* **Drift** — a new `borough`, `type`, `status`, NTA shape or ZIP shape upstream.
  Reported loudly but non-fatal, because the app degrades gracefully; `--strict`
  promotes it to a failure for CI.

Usage:
    python3 scripts/validate_data.py [--strict] [--min-records N]
"""

from __future__ import annotations

import argparse
import math
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))

import _common as C  # noqa: E402

# --------------------------------------------------------------------------- SCHEMA

#: Values this pipeline knows about, measured against the live dataset on
#: 2026-09-27 (docs/data-dictionary.md). Anything outside these sets is drift,
#: not corruption, and must be noticed deliberately.
SCHEMA: dict[str, Any] = {
    "datasetId": C.DATASET_ID,
    "dataset": C.DATASET_NAME,
    "provider": C.PROVIDER,
    "attribution": C.ATTRIBUTION,
    "boroughs": set(C.BOROUGHS),
    "diningTypes": set(C.DINING_TYPES),
    "sourceLicenseTypes": set(C.SOURCE_LICENSE_TYPES),
    # license_status is a single value in the live data, which is why no status
    # filter is shipped. If DOT starts publishing Expired, that changes.
    "licenseStatuses": {"Issued"},
    "ntaLength": 6,
    "zipLength": 5,
    "bblLength": 10,
    # A NYC BBL is 10 digits, but two city-owned parcels in the live data
    # geocode to 8 ("18830048", 384 3 AVENUE) and 9 ("115510024", 1701 1 AVENUE).
    # Anything shorter than 8 is the degenerate "1"/"3" junk clean_data nulls.
    "bblDigitRange": (8, 10),
    "idPattern": C.ID_RE.pattern,
    "sourceRows": 2437,
    "publishedLocations": 2000,
    "rejected": {
        "outOfBounds": 2,
        "unknownBorough": 4,
        "unparseableCoordinates": 0,
        "missingCoordinates": 0,
    },
    "types": {"sidewalk": 1173, "roadway": 396, "both": 431},
}

#: Guard band against a truncated or half-fetched snapshot. 25% below the
#: 2026-09-27 measurement; a real refresh never moves this far in a day.
MIN_EXPECTED_RECORDS = 1500

REJECTION_CODE_TO_KEY = {
    "out_of_bounds": "outOfBounds",
    "unknown_borough": "unknownBorough",
    "unparseable_coordinates": "unparseableCoordinates",
    "missing_coordinates": "missingCoordinates",
}
EXTENDED_REJECTION_CODES = C.EXTENDED_REJECTION_CODES


@dataclass
class Result:
    errors: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    stats: dict[str, Any] = field(default_factory=dict)

    def error(self, message: str) -> None:
        self.errors.append(message)

    def warn(self, message: str) -> None:
        self.warnings.append(message)

    def note_drift(self, message: str) -> None:
        self.warnings.append(f"SCHEMA DRIFT: {message}")


def js_kind(value: Any) -> str:
    """The JSON type name a JavaScript reader would report."""
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "boolean"
    if isinstance(value, (int, float)):
        return "number"
    if isinstance(value, str):
        return "string"
    if isinstance(value, list):
        return "array"
    if isinstance(value, dict):
        return "object"
    return type(value).__name__


def check_geojson(geojson: Any, result: Result) -> list[dict]:
    if not isinstance(geojson, dict):
        result.error(f"cafes.geojson must be a JSON object, got {js_kind(geojson)}")
        return []
    if geojson.get("type") != "FeatureCollection":
        result.error(f"cafes.geojson type is {geojson.get('type')!r}, expected 'FeatureCollection'")
    features = geojson.get("features")
    if not isinstance(features, list):
        result.error("cafes.geojson features must be an array")
        return []

    seen: dict[str, int] = {}
    seen_sids: dict[str, str] = {}
    boroughs: dict[str, int] = {}
    counts: dict[str, int] = {t: 0 for t in C.DINING_TYPES}
    unknown_boroughs: dict[str, int] = {}
    unknown_types: dict[str, int] = {}
    unknown_statuses: dict[str, int] = {}
    bad_zip = bad_nta = bad_bbl = 0
    multi_sid = 0

    for index, feature in enumerate(features):
        where = f"feature[{index}]"
        if not isinstance(feature, dict):
            result.error(f"{where} is {js_kind(feature)}, expected an object")
            continue
        if feature.get("type") != "Feature":
            result.error(f"{where}.type is {feature.get('type')!r}, expected 'Feature'")

        geometry = feature.get("geometry")
        if not isinstance(geometry, dict) or geometry.get("type") != "Point":
            result.error(f"{where}.geometry must be a Point")
        else:
            coordinates = geometry.get("coordinates")
            if (
                not isinstance(coordinates, list)
                or len(coordinates) != 2
                or not all(isinstance(c, (int, float)) and math.isfinite(c) for c in coordinates)
            ):
                result.error(f"{where}.geometry.coordinates must be two finite numbers")
            else:
                lon, lat = coordinates
                if not C.in_nyc_bbox(lat, lon):
                    result.error(
                        f"{where} coordinates {lon},{lat} are outside the NYC bounding box "
                        f"lat[{C.LAT_MIN},{C.LAT_MAX}] lng[{C.LNG_MIN},{C.LNG_MAX}]"
                    )

        properties = feature.get("properties")
        if not isinstance(properties, dict):
            result.error(f"{where}.properties must be an object")
            continue

        for name in C.PROPERTY_ORDER:
            if name not in properties:
                result.error(f"{where}.properties is missing {name!r}")
        for name in properties:
            if name not in C.PROPERTY_ORDER:
                result.note_drift(f"{where}.properties has unexpected key {name!r}")
        for name, allowed in C.PROPERTY_TYPES.items():
            if name in properties:
                kind = js_kind(properties[name])
                if kind not in allowed:
                    result.error(
                        f"{where}.properties.{name} is {kind}, expected one of {list(allowed)}"
                    )

        location_id = properties.get("id")
        if isinstance(location_id, str):
            if not C.ID_RE.match(location_id):
                result.error(f"{where} id {location_id!r} does not match {SCHEMA['idPattern']}")
            if location_id in seen:
                result.error(f"duplicate id {location_id!r} at features {seen[location_id]} and {index}")
            else:
                seen[location_id] = index
            if feature.get("id") != location_id:
                result.error(f"{where}.id {feature.get('id')!r} != properties.id {location_id!r}")

        borough = properties.get("borough")
        if isinstance(borough, str):
            if borough in SCHEMA["boroughs"]:
                boroughs[borough] = boroughs.get(borough, 0) + 1
            else:
                unknown_boroughs[borough] = unknown_boroughs.get(borough, 0) + 1

        dining_type = properties.get("type")
        if isinstance(dining_type, str):
            if dining_type in SCHEMA["diningTypes"]:
                counts[dining_type] += 1
            else:
                unknown_types[dining_type] = unknown_types.get(dining_type, 0) + 1

        status = properties.get("status")
        if isinstance(status, str) and status not in SCHEMA["licenseStatuses"]:
            unknown_statuses[status] = unknown_statuses.get(status, 0) + 1

        zip_value = properties.get("zip")
        if isinstance(zip_value, str) and len(zip_value) != SCHEMA["zipLength"]:
            bad_zip += 1
        nta = properties.get("nta")
        if isinstance(nta, str) and len(nta) != SCHEMA["ntaLength"]:
            bad_nta += 1
        bbl = properties.get("bbl")
        if isinstance(bbl, str):
            low, high = SCHEMA["bblDigitRange"]
            if not (bbl.isdigit() and low <= len(bbl) <= high):
                bad_bbl += 1

        sid = properties.get("sid")
        if isinstance(sid, list):
            if not sid:
                result.error(f"{where}.properties.sid is empty; every feature needs its source row")
            elif not all(isinstance(s, str) and s for s in sid):
                result.error(f"{where}.properties.sid must be a non-empty array of strings")
            else:
                if len(sid) > 1:
                    multi_sid += 1
                if list(sid) != sorted(sid):
                    result.error(f"{where}.properties.sid must be sorted")
                for value in sid:
                    if value in seen_sids:
                        result.error(
                            f"source row {value!r} published twice "
                            f"({seen_sids[value]} and {location_id})"
                        )
                    else:
                        seen_sids[value] = str(location_id)
        else:
            result.error(f"{where}.properties.sid must be an array")

    for value, count in sorted(unknown_boroughs.items()):
        result.note_drift(f"unknown borough {value!r} x{count}; known: {sorted(SCHEMA['boroughs'])}")
    for value, count in sorted(unknown_types.items()):
        result.note_drift(f"unknown type {value!r} x{count}; known: {sorted(SCHEMA['diningTypes'])}")
    for value, count in sorted(unknown_statuses.items()):
        result.note_drift(
            f"unknown license_status {value!r} x{count}; "
            f"known: {sorted(SCHEMA['licenseStatuses'])}"
        )
    if bad_zip:
        result.note_drift(f"{bad_zip} zip values are not {SCHEMA['zipLength']} characters")
    if bad_nta:
        result.note_drift(f"{bad_nta} nta values are not {SCHEMA['ntaLength']} characters")
    if bad_bbl:
        low, high = SCHEMA["bblDigitRange"]
        result.note_drift(
            f"{bad_bbl} bbl values are not {low}-{high} digits (a full BBL is {SCHEMA['bblLength']})"
        )

    result.stats.update(
        recordCount=len(features),
        counts=counts,
        boroughs=boroughs,
        uniqueIds=len(seen),
        uniqueSourceRows=len(seen_sids),
        mergedFeatures=multi_sid,
    )
    return features


def check_metadata(metadata: Any, result: Result) -> None:
    if not isinstance(metadata, dict):
        result.error(f"metadata.json must be a JSON object, got {js_kind(metadata)}")
        return
    required = (
        "dataset",
        "datasetId",
        "provider",
        "source",
        "attribution",
        "retrievedAt",
        "sourceUpdatedAt",
        "recordCount",
        "sourceRowCount",
        "contentHash",
        "counts",
        "boroughs",
    )
    for key in required:
        if key not in metadata:
            result.error(f"metadata.json is missing {key!r}")
    for key, expected in (
        ("dataset", SCHEMA["dataset"]),
        ("datasetId", SCHEMA["datasetId"]),
        ("provider", SCHEMA["provider"]),
        ("attribution", SCHEMA["attribution"]),
    ):
        if key in metadata and metadata[key] != expected:
            result.note_drift(f"metadata.{key} is {metadata[key]!r}, expected {expected!r}")
    for key in ("retrievedAt", "sourceUpdatedAt"):
        value = metadata.get(key)
        if value is not None and not (isinstance(value, str) and value.endswith("Z")):
            result.error(f"metadata.{key} must be an ISO-8601 UTC string ending in Z, got {value!r}")
    counts = metadata.get("counts")
    if not isinstance(counts, dict) or set(counts) != SCHEMA["diningTypes"]:
        result.error(
            f"metadata.counts must have exactly {sorted(SCHEMA['diningTypes'])}, got "
            f"{sorted(counts) if isinstance(counts, dict) else js_kind(counts)}"
        )
    boroughs = metadata.get("boroughs")
    if not isinstance(boroughs, dict) or not boroughs:
        result.error("metadata.boroughs must be a non-empty object")


def check_report(report: Any, result: Result) -> None:
    if not isinstance(report, dict):
        result.error(f"report.json must be a JSON object, got {js_kind(report)}")
        return
    required = (
        "sourceRows",
        "publishedLocations",
        "rejected",
        "mergedSidewalkAndRoadway",
        "duplicatesRemoved",
        "sidewalk",
        "roadway",
        "both",
        "contentHash",
        "generatedAt",
        "rejections",
    )
    for key in required:
        if key not in report:
            result.error(f"report.json is missing {key!r}")
    rejected = report.get("rejected")
    if isinstance(rejected, dict):
        missing = set(REJECTION_CODE_TO_KEY.values()) - set(rejected)
        extra = set(rejected) - set(REJECTION_CODE_TO_KEY.values())
        if missing:
            result.error(f"report.rejected is missing {sorted(missing)}")
        if extra:
            result.note_drift(f"report.rejected has unexpected keys {sorted(extra)}")
    rejections = report.get("rejections")
    if isinstance(rejections, list):
        for index, item in enumerate(rejections):
            if not isinstance(item, dict):
                result.error(f"report.rejections[{index}] is not an object")
                continue
            for key in ("name", "street", "city", "borough", "latitude", "longitude", "reason"):
                if key not in item:
                    result.error(f"report.rejections[{index}] is missing {key!r}")


def cross_check(
    geojson: dict,
    features: list[dict],
    metadata: dict,
    report: dict,
    fetch_meta: dict | None,
    result: Result,
    min_records: int,
) -> None:
    if not isinstance(metadata, dict) or not isinstance(report, dict) or not features:
        if not features and isinstance(metadata, dict):
            result.error("cafes.geojson has no features; refusing to certify an empty dataset")
        return

    actual_count = len(features)
    observed = result.stats.get("counts", {})

    if actual_count < min_records:
        result.error(
            f"record count collapse: {actual_count} locations, expected at least {min_records} "
            f"(2026-09-27 measured {SCHEMA['publishedLocations']})"
        )
    if isinstance(metadata.get("recordCount"), int) and metadata["recordCount"] != actual_count:
        result.error(
            f"metadata.recordCount {metadata['recordCount']} != {actual_count} features in cafes.geojson"
        )
    if isinstance(report.get("publishedLocations"), int) and report["publishedLocations"] != actual_count:
        result.error(
            f"report.publishedLocations {report['publishedLocations']} != {actual_count} features"
        )
    if isinstance(report.get("sourceRows"), int) and report["sourceRows"] < actual_count:
        result.error(
            f"report.sourceRows {report['sourceRows']} is fewer than the {actual_count} published locations"
        )
    if fetch_meta and isinstance(fetch_meta.get("rowCount"), int):
        if report["sourceRows"] != fetch_meta["rowCount"]:
            result.error(
                f"report.sourceRows {report['sourceRows']} != fetch-meta.rowCount {fetch_meta['rowCount']}"
            )
        if metadata.get("sourceRowCount") != fetch_meta["rowCount"]:
            result.error(
                f"metadata.sourceRowCount {metadata.get('sourceRowCount')} != "
                f"fetch-meta.rowCount {fetch_meta['rowCount']}"
            )

    for key in ("sidewalk", "roadway", "both"):
        if isinstance(report.get(key), int) and report[key] != observed.get(key, 0):
            result.error(
                f"report.{key} {report[key]} != {observed.get(key, 0)} features of that type"
            )
        if isinstance(metadata.get("counts"), dict) and key in metadata["counts"]:
            if metadata["counts"][key] != observed.get(key, 0):
                result.error(
                    f"metadata.counts.{key} {metadata['counts'][key]} != {observed.get(key, 0)}"
                )

    boroughs = result.stats.get("boroughs", {})
    if isinstance(metadata.get("boroughs"), dict) and metadata["boroughs"] != boroughs:
        result.error(f"metadata.boroughs {metadata['boroughs']} != {boroughs} observed in cafes.geojson")
    if sum(boroughs.values()) != actual_count:
        result.error(f"borough counts sum to {sum(boroughs.values())}, not {actual_count}")

    digest = C.content_hash(features)
    for label, value in (("metadata.contentHash", metadata.get("contentHash")),
                         ("report.contentHash", report.get("contentHash"))):
        if value != digest:
            result.error(f"{label} {value!r} != sha256 over cafes.geojson {digest!r}")

    rejected = report.get("rejected") if isinstance(report.get("rejected"), dict) else {}
    rejections = report.get("rejections") if isinstance(report.get("rejections"), list) else []
    by_code: dict[str, int] = {}
    for item in rejections:
        reason = item.get("reason", "") if isinstance(item, dict) else ""
        code = str(reason).split(":")[0].strip()
        by_code[code] = by_code.get(code, 0) + 1
        if code not in REJECTION_CODE_TO_KEY and code not in EXTENDED_REJECTION_CODES:
            result.note_drift(f"report.rejections has unknown reason code {code!r}")
    for code, key in REJECTION_CODE_TO_KEY.items():
        if by_code.get(code, 0) != rejected.get(key, 0):
            result.error(
                f"report.rejected.{key} is {rejected.get(key)} but {by_code.get(code, 0)} rejections "
                f"carry reason {code!r}"
            )
    total_rejected = sum(int(v) for v in rejected.values() if isinstance(v, int))
    if total_rejected + sum(
        n for code, n in by_code.items() if code in EXTENDED_REJECTION_CODES
    ) != len(rejections):
        result.error(
            f"report: {len(rejections)} rejections recorded but the counters account for "
            f"{total_rejected} + extended"
        )
    if isinstance(report.get("sourceRows"), int) and isinstance(report.get("duplicatesRemoved"), int):
        kept = report["sourceRows"] - total_rejected
        if kept - report["duplicatesRemoved"] != actual_count:
            result.error(
                f"report arithmetic: {report['sourceRows']} source rows - {total_rejected} rejected - "
                f"{report['duplicatesRemoved']} duplicates != {actual_count} published"
            )
    if isinstance(report.get("mergedSidewalkAndRoadway"), int) and report["mergedSidewalkAndRoadway"] != observed.get("both", 0):
        result.error(
            f"report.mergedSidewalkAndRoadway {report['mergedSidewalkAndRoadway']} != "
            f"{observed.get('both', 0)} features of type 'both'"
        )

    for label, expected in (
        ("sourceRows", SCHEMA["sourceRows"]),
        ("publishedLocations", SCHEMA["publishedLocations"]),
    ):
        value = report.get(label)
        if isinstance(value, int) and value != expected:
            result.note_drift(
                f"report.{label} is {value}, the 2026-09-27 measurement was {expected}"
            )
    for key, expected in SCHEMA["types"].items():
        value = report.get(key)
        if isinstance(value, int) and value != expected:
            result.note_drift(f"report.{key} is {value}, the 2026-09-27 measurement was {expected}")
    for key, expected in SCHEMA["rejected"].items():
        value = rejected.get(key)
        if isinstance(value, int) and value != expected:
            result.note_drift(
                f"report.rejected.{key} is {value}, the 2026-09-27 measurement was {expected}"
            )
    anomalies = report.get("mergeAnomalies")
    if isinstance(anomalies, list) and anomalies:
        result.note_drift(f"{len(anomalies)} merge anomalies recorded in report.json")


def validate(min_records: int = MIN_EXPECTED_RECORDS) -> Result:
    result = Result()
    for path in (C.GEOJSON_PATH, C.METADATA_PATH, C.REPORT_PATH):
        if not path.exists():
            result.error(f"missing artifact: {path} — run scripts/refresh_data.py")
    if result.errors:
        return result

    try:
        geojson = C.read_json_file(C.GEOJSON_PATH)
        metadata = C.read_json_file(C.METADATA_PATH)
        report = C.read_json_file(C.REPORT_PATH)
    except C.DataError as exc:
        result.error(str(exc))
        return result
    fetch_meta = C.load_fetch_meta()

    features = check_geojson(geojson, result)
    check_metadata(metadata, result)
    check_report(report, result)
    cross_check(geojson, features, metadata, report, fetch_meta, result, min_records)
    return result


def format_result(result: Result) -> str:
    stats = result.stats
    lines = ["VALIDATION"]
    if stats:
        counts = stats.get("counts", {})
        lines.append(
            f"  features {stats.get('recordCount')}"
            f"   unique ids {stats.get('uniqueIds')}"
            f"   source rows referenced {stats.get('uniqueSourceRows')}"
        )
        lines.append(
            "  types    "
            + "  ".join(f"{t} {counts.get(t, 0)}" for t in C.DINING_TYPES)
            + f"   merged (sid>1) {stats.get('mergedFeatures')}"
        )
        lines.append("  boroughs " + C.compact_json(stats.get("boroughs", {})))
    if result.warnings:
        lines.append(f"  {len(result.warnings)} warning(s) — schema drift, see below")
        for warning in result.warnings:
            lines.append(f"    ! {warning}")
    if result.errors:
        lines.append(f"  FAILED with {len(result.errors)} error(s)")
        for error in result.errors[:40]:
            lines.append(f"    x {error}")
        if len(result.errors) > 40:
            lines.append(f"    ... and {len(result.errors) - 40} more")
    else:
        lines.append("  ok — artifacts match the contract")
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument(
        "--strict", action="store_true", help="treat schema-drift warnings as failures (for CI)"
    )
    parser.add_argument(
        "--min-records",
        type=int,
        default=MIN_EXPECTED_RECORDS,
        help=f"fail below this record count (default {MIN_EXPECTED_RECORDS})",
    )
    args = parser.parse_args(argv)

    try:
        result = validate(min_records=args.min_records)
    except C.PipelineError as exc:
        print(f"validate_data: {exc}", file=sys.stderr)
        return 1

    print(format_result(result))
    if result.errors:
        return 1
    if args.strict and result.warnings:
        print(
            f"validate_data: --strict and {len(result.warnings)} drift warning(s); see above",
            file=sys.stderr,
        )
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
