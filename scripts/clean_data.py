#!/usr/bin/env python3
"""raw snapshot -> public/data/cafes.geojson, metadata.json, report.json.

The whole contract lives in _common.py and docs/data-dictionary.md. This module
is deliberately boring: validate, merge, emit. Every rejection is recorded and
every unexpected shape is surfaced. Nothing is silently repaired.

Usage:
    python3 scripts/clean_data.py [--raw PATH] [--quiet]
"""

from __future__ import annotations

import argparse
import collections
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable

sys.path.insert(0, str(Path(__file__).resolve().parent))

import _common as C  # noqa: E402

#: Rejection precedence when a row breaks more than one rule. Borough leads
#: because a null/non-NYC borough means the row is not in the program at all,
#: which is the more fundamental finding than a bad geocode.
#: Counters that are not derivable from the published features: they exist so a
#: normalisation or a drift can never happen quietly.
PIPELINE_KEYS = (
    "unknownLicenseType",
    "missingIdentity",
    "ambiguousLicenseGroup",
    "missingZip",
    "missingStatus",
    "degenerateBbl",
    "whitespaceCollapsed",
    "nullishText",
    "mergeAnomalies",
)

REJECTION_PRECEDENCE = (
    "missing_identity",
    "missing_coordinates",
    "unparseable_coordinates",
    "unknown_borough",
    "out_of_bounds",
    "unknown_license_type",
)


@dataclass
class SourceRow:
    """One source row after normalisation, ready to be validated."""

    sid: str | None
    legal_name: str | None
    assumed_name: str | None
    street: str | None
    neighborhood: str | None
    borough: str | None
    zip: str | None
    license_type: str | None
    status: str | None
    issued: str | None
    expires: str | None
    nta: str | None
    bbl: str | None
    latitude: float | None
    longitude: float | None
    #: "missing_coordinates" / "unparseable_coordinates" when the point is unusable.
    coordinate_error: str | None
    source: dict = field(repr=False, default_factory=dict)

    @property
    def sort_key(self) -> tuple[str, str]:
        """Deterministic order inside a merge group, independent of row order."""
        return (self.sid or "", C.canonical_json(self.source))

    @property
    def identity(self) -> tuple[str | None, str | None]:
        return (self.legal_name, self.street)


@dataclass
class Outcome:
    features: list[dict]
    report: dict
    metadata: dict
    rejections: list[dict]
    merge_anomalies: list[str]
    pipeline: dict


# --------------------------------------------------------------------------- normalise


def _changed(before: Any, after: Any) -> bool:
    raw = "" if before is None else before
    return isinstance(raw, str) and raw != (after or "")


def normalise_row(row: dict, counters: collections.Counter) -> SourceRow:
    """Whitespace + nullish-token normalisation, and the bbl degenerate check."""
    for column in ("business_legal_name", "assumed_name_s", "street", "city", "postcode", "nta2020"):
        before = row.get(column)
        after = C.normalise_text(before)
        if _changed(before, after):
            if after is None:
                counters["nullishText"] += 1
            else:
                counters["whitespaceCollapsed"] += 1

    bbl, degenerate = C.normalise_bbl(row.get("bbl"))
    if degenerate:
        counters["degenerateBbl"] += 1

    lat, lon, failure = C.coordinates_of(row)
    if failure is not None:
        # Still build a row so the rejection can be recorded against it; nothing
        # downstream reads coordinates without checking them first.
        lat = lon = None

    return SourceRow(
        sid=C.normalise_text(row.get(":id")),
        legal_name=C.normalise_text(row.get("business_legal_name")),
        assumed_name=C.normalise_text(row.get("assumed_name_s")),
        street=C.normalise_text(row.get("street")),
        neighborhood=C.normalise_text(row.get("city")),
        borough=C.normalise_text(row.get("borough")),
        zip=C.normalise_text(row.get("postcode")),
        license_type=C.normalise_text(row.get("license_type")),
        status=C.normalise_text(row.get("license_status")),
        issued=C.normalise_date(row.get("license_issue_date")),
        expires=C.normalise_date(row.get("license_expiration_date")),
        nta=C.normalise_text(row.get("nta2020")),
        bbl=bbl,
        latitude=lat,
        longitude=lon,
        coordinate_error=failure,
        source=row,
    )


# --------------------------------------------------------------------------- validate


def rejection(row: SourceRow, code: str, detail: str) -> dict:
    return {
        "name": row.assumed_name or row.legal_name,
        "street": row.street,
        "city": row.neighborhood,
        "borough": row.borough,
        "latitude": row.latitude,
        "longitude": row.longitude,
        "reason": f"{code}: {detail}",
    }


def rejection_codes(row: SourceRow) -> list[str]:
    """Every rule this row breaks, in precedence order."""
    codes: list[str] = []
    if row.legal_name is None or row.street is None:
        codes.append("missing_identity")
    if row.coordinate_error is not None:
        codes.append(row.coordinate_error)
    else:
        if not C.in_nyc_bbox(row.latitude, row.longitude):
            codes.append("out_of_bounds")
        if row.borough not in C.BOROUGHS:
            codes.append("unknown_borough")
    if row.license_type not in C.LICENSE_TYPE_TO_DINING:
        codes.append("unknown_license_type")
    return sorted(codes, key=REJECTION_PRECEDENCE.index)


def describe(row: SourceRow, code: str) -> str:
    if code == "missing_identity":
        missing = "business_legal_name" if row.legal_name is None else "street"
        return f"{missing} is empty, so there is no stable id to publish"
    if code == "missing_coordinates":
        return "latitude or longitude is missing"
    if code == "unparseable_coordinates":
        return (
            f"latitude={row.source.get('latitude')!r} longitude={row.source.get('longitude')!r}"
            " is not a number"
        )
    if code == "out_of_bounds":
        return (
            f"{row.latitude},{row.longitude} is outside the NYC bounding box "
            f"lat[{C.LAT_MIN},{C.LAT_MAX}] lng[{C.LNG_MIN},{C.LNG_MAX}]"
        )
    if code == "unknown_borough":
        return (
            f"borough={row.borough!r} is not one of {list(C.BOROUGHS)}"
            f" (city={row.neighborhood!r} postcode={row.zip!r})"
        )
    if code == "unknown_license_type":
        return (
            f"license_type={row.license_type!r} is not one of {list(C.LICENSE_TYPE_TO_DINING)}"
        )
    if code == "ambiguous_license_group":
        return "the group's license_type set cannot be represented as a single DiningType"
    return "rejected"


REJECTION_BUCKETS = {
    "out_of_bounds": "outOfBounds",
    "unknown_borough": "unknownBorough",
    "unparseable_coordinates": "unparseableCoordinates",
    "missing_coordinates": "missingCoordinates",
}


def validate_all(rows: Iterable[SourceRow]) -> tuple[list[SourceRow], list[dict], dict]:
    """Split rows into kept/rejected. Returns (kept, rejections, counters)."""
    kept: list[SourceRow] = []
    rejections: list[dict] = []
    counters: collections.Counter = collections.Counter()
    for row in rows:
        codes = rejection_codes(row)
        if not codes:
            kept.append(row)
            continue
        primary = codes[0]
        counters[REJECTION_BUCKETS.get(primary, primary)] += 1
        rejections.append(rejection(row, primary, describe(row, primary)))
    rejections.sort(key=lambda r: (r["reason"].split(":")[0], r["name"] or "", r["street"] or ""))
    return kept, rejections, dict(counters)


# --------------------------------------------------------------------------- merge


def _pick(members: list[SourceRow], attribute: str) -> Any:
    """First non-empty value in deterministic member order."""
    for member in members:
        value = getattr(member, attribute)
        if value not in (None, ""):
            return value
    return None


def merge_groups(kept: list[SourceRow]) -> tuple[list[dict], list[str], list[dict], dict]:
    """(legalName, street) -> one feature. Sidewalk+Roadway becomes `both`.

    Returns (features, anomalies, extra_rejections, counters).
    """
    groups: dict[tuple[str | None, str | None], list[SourceRow]] = collections.defaultdict(list)
    for row in kept:
        groups[row.identity].append(row)

    features: list[dict] = []
    anomalies: list[str] = []
    extra_rejections: list[dict] = []
    counters: collections.Counter = collections.Counter()

    for key in sorted(groups, key=lambda k: (k[0] or "", k[1] or "")):
        members = sorted(groups[key], key=lambda r: r.sort_key)
        label = f"{key[0]} / {key[1]}"
        types = {m.license_type for m in members}
        coordinates = {(m.latitude, m.longitude) for m in members}

        if len(members) > 2:
            anomalies.append(
                f"group_of_{len(members)}_plus: {label} has {len(members)} rows "
                f"(sids: {', '.join(sorted(m.sid or '?' for m in members))})"
            )
        if len(members) > 1 and len(types) == 1:
            anomalies.append(
                f"repeated_license_type: {label} has {len(members)} rows of license_type="
                f"{next(iter(types))!r}; expected one Sidewalk and one Roadway"
            )
        if len(coordinates) > 1:
            anomalies.append(
                f"coordinate_disagreement: {label} has coordinates "
                + " and ".join(f"{lat},{lon}" for lat, lon in sorted(coordinates))
                + "; published the lowest-:id row's point"
            )
        if any(m.bbl != _pick(members, "bbl") for m in members):
            anomalies.append(f"bbl_disagreement: {label} members disagree on bbl; used first non-null")

        if types == C.BOTH_PAIR:
            dining_type = "both"
        elif len(types) == 1:
            dining_type = C.LICENSE_TYPE_TO_DINING.get(next(iter(types)))
        else:
            dining_type = None

        if dining_type is None:
            for member in members:
                counters["ambiguousLicenseGroup"] += 1
                extra_rejections.append(
                    rejection(
                        member,
                        "ambiguous_license_group",
                        describe(member, "ambiguous_license_group"),
                    )
                )
            anomalies.append(
                f"ambiguous_license_group: {label} has license_type set "
                f"{sorted(t or 'null' for t in types)}, which is not a single DiningType"
            )
            continue

        if dining_type == "both":
            counters["mergedSidewalkAndRoadway"] += 1

        primary = members[0]
        zip_value = _pick(members, "zip")
        status = _pick(members, "status")
        if zip_value is None:
            counters["missingZip"] += 1
            zip_value = ""
        if status is None:
            counters["missingStatus"] += 1
            status = ""

        feature_id = C.location_id(key[0] or "", key[1] or "")
        properties = {
            "id": feature_id,
            "name": _pick(members, "assumed_name") or key[0],
            "legalName": key[0],
            "street": key[1],
            "neighborhood": _pick(members, "neighborhood"),
            "borough": _pick(members, "borough"),
            "zip": zip_value,
            "type": dining_type,
            "status": status,
            "licenseIssued": _pick(members, "issued"),
            "licenseExpires": _pick(members, "expires"),
            "nta": _pick(members, "nta"),
            "bbl": _pick(members, "bbl"),
            "sid": sorted(m.sid for m in members if m.sid),
        }
        assert tuple(properties) == C.PROPERTY_ORDER, "property order drifted from the contract"
        features.append(
            {
                "type": "Feature",
                "id": feature_id,
                "geometry": {
                    "type": "Point",
                    "coordinates": [primary.longitude, primary.latitude],
                },
                "properties": properties,
            }
        )

    features.sort(key=lambda f: f["id"])
    counters["mergeAnomalies"] = len(anomalies)
    return features, anomalies, extra_rejections, dict(counters)


# --------------------------------------------------------------------------- artifacts


def build_artifacts(
    raw_rows: list[dict],
    *,
    retrieved_at: str | None = None,
    source_updated_at: str | None = None,
    generated_at: str | None = None,
) -> Outcome:
    now = C.iso_now()
    retrieved_at = retrieved_at or now
    generated_at = generated_at or now

    counters: collections.Counter = collections.Counter()
    rows = [normalise_row(row, counters) for row in raw_rows]
    kept, rejections, validation_counters = validate_all(rows)
    features, anomalies, merge_rejections, merge_counters = merge_groups(kept)
    rejections = rejections + merge_rejections

    counts = {t: 0 for t in C.DINING_TYPES}
    seen_boroughs: collections.Counter = collections.Counter()
    for feature in features:
        counts[feature["properties"]["type"]] += 1
        seen_boroughs[feature["properties"]["borough"]] += 1
    # Canonical order, and only the boroughs that actually occur: a phantom
    # "Manhattan": 0 would disagree with anything recomputed from the geojson.
    boroughs = {b: seen_boroughs[b] for b in C.BOROUGHS if seen_boroughs[b]}

    digest = C.content_hash(features)

    pipeline = {key: int(counters.get(key, 0)) for key in PIPELINE_KEYS}
    pipeline["unknownLicenseType"] += int(validation_counters.get("unknown_license_type", 0))
    pipeline["missingIdentity"] += int(validation_counters.get("missing_identity", 0))
    pipeline["ambiguousLicenseGroup"] += int(merge_counters.get("ambiguousLicenseGroup", 0))
    pipeline["mergeAnomalies"] = len(anomalies)

    rejected = {
        "outOfBounds": int(validation_counters.get("outOfBounds", 0)),
        "unknownBorough": int(validation_counters.get("unknownBorough", 0)),
        "unparseableCoordinates": int(validation_counters.get("unparseableCoordinates", 0)),
        "missingCoordinates": int(validation_counters.get("missingCoordinates", 0)),
    }

    report = {
        "sourceRows": len(raw_rows),
        "publishedLocations": len(features),
        "rejected": rejected,
        "mergedSidewalkAndRoadway": int(merge_counters.get("mergedSidewalkAndRoadway", 0)),
        "duplicatesRemoved": len(kept) - len(features),
        "sidewalk": counts["sidewalk"],
        "roadway": counts["roadway"],
        "both": counts["both"],
        "contentHash": digest,
        "generatedAt": generated_at,
        "rejections": rejections,
        # Additive, non-breaking extensions to DataReport. DataReport is a TS
        # interface, so extra keys in the parsed JSON are structurally harmless,
        # and they keep drift from ever being silent.
        "pipeline": pipeline,
        "mergeAnomalies": anomalies,
    }

    metadata = {
        "dataset": C.DATASET_NAME,
        "datasetId": C.DATASET_ID,
        "provider": C.PROVIDER,
        "source": C.SOURCE_PAGE,
        "attribution": C.ATTRIBUTION,
        "retrievedAt": retrieved_at,
        "sourceUpdatedAt": source_updated_at,
        "recordCount": len(features),
        "sourceRowCount": len(raw_rows),
        "contentHash": digest,
        "counts": counts,
        "boroughs": boroughs,
    }

    return Outcome(
        features=features,
        report=report,
        metadata=metadata,
        rejections=rejections,
        merge_anomalies=anomalies,
        pipeline=pipeline,
    )


def verify_raw_snapshot(path: Path) -> dict:
    """Refuse to clean the canonical snapshot if it no longer matches its fetch metadata.

    Only applies to data/raw/fpeh-f7ci.json: an explicit --raw is some other
    file the caller has taken responsibility for.
    """
    if path.resolve() != C.RAW_DATA_PATH.resolve():
        return C.load_fetch_meta() or {}
    meta = C.load_fetch_meta()
    if meta is None:
        return {}
    expected = meta.get("responseSha256")
    if not expected:
        return meta
    actual = C.sha256_hex(path.read_bytes())
    if actual != expected:
        raise C.DataError(
            f"{path} does not match {C.FETCH_META_PATH.name} "
            f"(sha256 {actual} != {expected}); re-run scripts/fetch_data.py"
        )
    return meta


def write_artifacts(
    outcome: Outcome,
    *,
    geojson_path: Path | None = None,
    metadata_path: Path | None = None,
    report_path: Path | None = None,
) -> None:
    C.write_json_file(
        geojson_path or C.GEOJSON_PATH,
        {"type": "FeatureCollection", "features": outcome.features},
    )
    C.write_json_file(metadata_path or C.METADATA_PATH, outcome.metadata)
    C.write_json_file(report_path or C.REPORT_PATH, outcome.report)


def run(raw_path: Path | None = None, quiet: bool = False) -> Outcome:
    path = raw_path or C.RAW_DATA_PATH
    meta = verify_raw_snapshot(path)
    raw_rows = C.load_raw_rows(path)
    # retrievedAt is "now": when this artifact was generated, per the
    # DatasetMetadata contract. The fetch time lives in data/raw/fetch-meta.json.
    outcome = build_artifacts(raw_rows, source_updated_at=meta.get("sourceUpdatedAt"))
    write_artifacts(outcome)
    if not quiet:
        print(format_summary(outcome))
    return outcome


def format_summary(outcome: Outcome) -> str:
    report = outcome.report
    rejected = report["rejected"]
    lines = [
        f"  source rows           {report['sourceRows']}",
        f"  rejected              {sum(rejected.values())}"
        f"  (out_of_bounds {rejected['outOfBounds']}, unknown_borough {rejected['unknownBorough']},"
        f" unparseable_coordinates {rejected['unparseableCoordinates']},"
        f" missing_coordinates {rejected['missingCoordinates']})",
        f"  rows surviving        {report['sourceRows'] - sum(rejected.values())}",
        f"  published locations   {report['publishedLocations']}",
        f"  types                 sidewalk {report['sidewalk']}, roadway {report['roadway']},"
        f" both {report['both']}",
        f"  merged pairs          {report['mergedSidewalkAndRoadway']}"
        f"  (duplicates removed {report['duplicatesRemoved']})",
        f"  boroughs              {C.compact_json(outcome.metadata['boroughs'])}",
        f"  content hash          {report['contentHash']}",
        f"  degenerate bbl        {outcome.pipeline['degenerateBbl']}",
    ]
    if outcome.rejections:
        lines.append("  rejections")
        for item in outcome.rejections:
            lines.append(
                f"    - {item['reason']}  [{item['name']} / {item['street']}"
                f" / city={item['city']} / borough={item['borough']}]"
            )
    if outcome.merge_anomalies:
        lines.append("  merge anomalies (upstream drift — investigate)")
        for item in outcome.merge_anomalies:
            lines.append(f"    ! {item}")
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--raw", type=Path, default=None, help="raw snapshot to read")
    parser.add_argument("--quiet", action="store_true", help="only report failures")
    args = parser.parse_args(argv)
    try:
        run(raw_path=args.raw, quiet=args.quiet)
    except C.PipelineError as exc:
        print(f"clean_data: {exc}", file=sys.stderr)
        return 1
    print(f"  wrote {C.display_path(C.GEOJSON_PATH)}")
    print(f"  wrote {C.display_path(C.METADATA_PATH)}")
    print(f"  wrote {C.display_path(C.REPORT_PATH)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
