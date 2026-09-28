#!/usr/bin/env python3
"""Assert the published historical artifacts against the frozen contract.

The contract is `HistoricalProperties` in src/types/walk.ts and
`HISTORY_PROPERTY_ORDER` / `HISTORY_PROPERTY_TYPES` in scripts/walk/_common.py.
Two implementations of one schema, nothing tying them together at runtime, so
this file is the only thing standing between a hand-edited artifact and a
deploy. Fail loudly and specifically.

THE CHECK THAT MATTERS MOST
===========================
Column-name drift. The source spells its survey columns three ways already —
`may_07_am` (underscore, two-digit year), `may26_am` (neither) and `may_22_p_m`
(the PM period split as `p` + `m`) — and `C.HISTORY_COLUMN_RE` is the one regex
that decides which ones exist. It now understands all three, which is why
`unhandledCountColumns` is 0 on the live snapshot. That is a statement about
TODAY, not a guarantee about tomorrow: if a fourth spelling appears, the regex
does not match it, the columns are dropped, and the published feature simply
loses that survey — with no error anywhere, because every remaining value is
still a perfectly valid count. The artifact looks fine. It is quietly missing
data.

So this file re-derives the count-shaped column names from the RAW snapshot
with a deliberately broader detector (`COUNT_COLUMN_SHAPE_RE`, in transform.py)
and compares that set against the set the transform says it consumed. Present
but unconsumed is schema drift, and it is FATAL. A refresh that drops half the
record must not be able to certify itself. A parser that has been taught three
spellings is not evidence it will be taught a fourth.

Usage:
    python3 scripts/walk/history/validate.py [--strict] [--min-locations N]
"""

from __future__ import annotations

import argparse
import math
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import _common as C  # noqa: E402

if __package__:
    # Imported as `history.validate` (tests, or `from history import validate`).
    # A relative import so there is exactly one copy of transform in the
    # process — a bare `from transform import ...` would load it a second time
    # under a second name whenever this module is imported as part of the
    # package.
    from .transform import COUNT_COLUMN_SHAPE_RE, REJECTION_PRECEDENCE  # noqa: E402
else:
    # Run as a script: python3 scripts/walk/history/validate.py
    from transform import COUNT_COLUMN_SHAPE_RE, REJECTION_PRECEDENCE  # noqa: E402

# --------------------------------------------------------------------------- SCHEMA
#
# Measured against the live dataset on 2026-09-28. A move in any of these is
# worth a look before it becomes a surprise; only the ones marked fatal block a
# deploy.

#: 114 sites, unchanged for the life of the program. A count collapse is a
#: truncated download, not a real change.
MIN_EXPECTED_LOCATIONS = 100

#: Size budgets, in bytes, of the published artifacts. Set at roughly three
#: times the measured size (geojson 57,744 B, patterns 448,116 B on
#: 2026-09-28) so that an ordinary refresh has enormous headroom and a runaway
#: — every possible survey emitted for every site, a per-survey coordinate
#: dump, a second copy of the geojson — trips it immediately. The budget exists
#: to catch "this file used to be a summary and is now a database", which no
#: per-field type check would ever notice.
MAX_GEOJSON_BYTES = 250_000
MAX_PATTERNS_BYTES = 1_500_000

#: `borough` IS NOT A BOROUGH COLUMN, and treating it as one is the whole trap.
#:
#: It is a source LOCATION DESCRIPTOR, and DOT overloads it. As of 2026-09-28,
#: 19 of 114 sites carry a value that is not one of the five boroughs:
#: "Harlem River Bridges" (9), "East River Bridges" (5) and a truncated
#: "Staten Isla" (5, on all five Staten Island sites). So the column is three
#: things in one — a borough, a bridge group, and a typo.
#:
#: The policy is PUBLISH VERBATIM AND WARN. Both alternatives are worse:
#:
#:   * Rejecting a non-borough drops 19 real count sites — real hand-counted
#:     screenline data on real bridges — over a naming problem.
#:   * Mapping them to a borough is invention. Deciding that "Harlem River
#:     Bridges" spans Manhattan and the Bronx means publishing a bridge-to-
#:     borough table the city never released, and every row of it would be a
#:     guess wearing a citation. A reader can see "Harlem River Bridges" and
#:     know exactly what DOT said; a reader shown "Manhattan" would believe
#:     something DOT never claimed. Note the trap in the truncated value: a
#:     nearest-match repair would confidently rewrite "Staten Isla" to "Staten
#:     Island" and be right, which is the most dangerous kind of repair —
#:     the one that cannot be caught by a test, because on today's data it is
#:     indistinguishable from having fixed a real error.
#:
#: So the value is published as it stands and this file reports it. The
#: warning is deliberately keyed on the CATEGORY (is this a borough? is it a
#: known bridge group?), never on a literal. Nothing here lists "Staten Isla",
#: and nothing keys on it: if the city later corrects those five values to
#: "Staten Island", this validator still passes, the sites still publish, and
#: the count moves from the not-a-borough tally to the borough tally. A check
#: that fails when a source typo is fixed is a check that has to be deleted
#: before the pipeline can be right.
KNOWN_BRIDGES = {"Harlem River Bridges", "East River Bridges"}

#: Values `iex` is known to take. Anything else means the boolean has become
#: ambiguous, which IS unsafe, so it fails.
KNOWN_INDEX_VALUES = {"Y", "N"}


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


#: The kind a Python value serialises to, as a JS reader sees it. NOT a local
#: definition: `C.js_kind` in scripts/walk/_common.py is the one place that
#: answers this, and `HISTORY_PROPERTY_TYPES` is written in its vocabulary
#: ("integer" and "boolean" are distinct from "number"). A second copy here
#: would be free to drift — a forgotten bool check would silently turn
#: `inPedestrianVolumeIndex: true` into a valid "integer".
js_kind = C.js_kind


# --------------------------------------------------------------------------- source drift


def check_source_drift(raw_rows: list[dict], report: Any, result: Result) -> None:
    """Re-derive the source's shape and compare it to what the transform claims.

    Everything here is fatal. These are the checks that turn "the pipeline ran
    and produced plausible JSON" into "the pipeline saw what we think it saw".
    """
    # The caller passes the whole report.json, which this half namespaced under
    # "history". Unwrap defensively rather than trusting the caller: a bare
    # half-report is the exact shape that would drop the sensor half on merge,
    # and this function must still be able to say so.
    half = report.get("history") if isinstance(report, dict) else None
    if half is None and isinstance(report, dict) and "pipeline" in report:
        # Tolerated: a caller that has already unwrapped. Not an error here —
        # check_report is the function that owns the top-level shape.
        half = report
    if not isinstance(half, dict):
        result.error(
            "report.history.pipeline is missing; the column-consumption record is required"
        )
        return
    pipeline = half.get("pipeline")
    if not isinstance(pipeline, dict):
        result.error("report.history.pipeline is missing; the column-consumption record is required")
        return

    # 1. Column spellings. The single most important check in this file.
    #
    # Two independent comparisons, because either alone is insufficient:
    #
    #   present = what the source has, by the broad shape detector.
    #   consumed = what the parser claims to have read, from the report.
    #
    # `present - consumed` catches a NEW spelling: the data is in the file and
    # the parser never looked at it. `consumed - present` catches a report
    # written against a different snapshot. And the two counts must be EQUAL —
    # asserted below, not inferred from the two set comparisons, so that a
    # count that is wrong on both sides identically still fails.
    present = {column for row in raw_rows for column in row if COUNT_COLUMN_SHAPE_RE.match(column)}
    consumed = set(pipeline.get("consumedCountColumnNames") or [])
    if not consumed:
        result.error(
            "report.pipeline.consumedCountColumnNames is empty; the transform must record "
            "which count columns it read"
        )
    unhandled = sorted(present - consumed)
    if unhandled:
        result.error(
            f"SCHEMA DRIFT: {len(unhandled)} count column(s) present in the source were NOT "
            f"consumed by the transform, so their values are missing from the published "
            f"artifacts: {', '.join(unhandled)}. C.HISTORY_COLUMN_RE in scripts/walk/_common.py "
            "does not match this spelling. Add it there (and to any column-name assertions) "
            "before publishing."
        )
    vanished = sorted(consumed - present)
    if vanished:
        result.error(
            f"SCHEMA DRIFT: report claims {len(vanished)} count column(s) the source no longer "
            f"has: {', '.join(vanished)}. The report was written against a different snapshot."
        )
    # The equality that closes the argument: nothing in the source shaped like a
    # count column went unread. On the live snapshot this is 111 == 111.
    if consumed and not unhandled and not vanished and len(present) != len(consumed):
        result.error(
            f"SCHEMA DRIFT: the source has {len(present)} count-shaped columns and the report "
            f"claims {len(consumed)} were consumed, with no set difference either way"
        )
    expected_counts = {
        "consumedCountColumns": len(consumed),
        "unhandledCountColumns": len(unhandled),
    }
    for label, expected in expected_counts.items():
        value = pipeline.get(label)
        if isinstance(value, int) and value != expected:
            result.error(
                f"report.pipeline.{label} is {value} but {expected} columns were actually seen; "
                "the report disagrees with the source"
            )

    # 2. Every row has a point.
    missing_geom = [
        str(row.get("loc") or f"index {index}")
        for index, row in enumerate(raw_rows)
        if row.get("the_geom") is None
    ]
    if missing_geom:
        result.error(
            f"SCHEMA DRIFT: {len(missing_geom)} source row(s) have no the_geom "
            f"(first: {', '.join(missing_geom[:5])}); the geometry column moved or was dropped"
        )

    # 3. Every count cell is a non-negative integer, or genuinely absent.
    #
    # `C.parse_count` maps a negative or unparseable cell to None, which is
    # right for the artifact and hides the fact. Re-parse it here, against the
    # raw value, so a cell reading "-3" or "twelve" fails instead of quietly
    # becoming a missing observation.
    bad_cells: list[str] = []
    nullish = 0
    for row in raw_rows[: C.FETCH_LIMIT]:
        loc = str(row.get("loc") or "?")
        for column, value in row.items():
            if not COUNT_COLUMN_SHAPE_RE.match(column):
                continue
            if C.normalise_text(value) is None:
                nullish += 1
                continue
            if C.parse_count(value) is None:
                bad_cells.append(f"{loc}.{column}={value!r}")
    if bad_cells:
        result.error(
            f"{len(bad_cells)} count cell(s) are present but not non-negative integers "
            f"(first: {', '.join(bad_cells[:5])})"
        )
    result.stats["nullCountCells"] = nullish

    # 4. Borough values. Report, do not reject, do not repair — see KNOWN_BRIDGES.
    #
    # Two numbers, both always printed, because the value itself is not
    # trustworthy as a drift signal: a change in `boroughs` is only obvious if
    # you also know how many distinct values there are. "7 distinct values, 19
    # of them not a borough" and "6 distinct values, 0 of them not a borough"
    # read the same way from a counts dict alone; the distinct count is what
    # makes the difference legible at a glance in a refresh log.
    boroughs: dict[str, int] = {}
    for row in raw_rows:
        value = C.normalise_text(row.get("borough"))
        boroughs[value or "<empty>"] = boroughs.get(value or "<empty>", 0) + 1
    not_a_borough = {
        value: count
        for value, count in boroughs.items()
        if value not in C.BOROUGHS and value not in KNOWN_BRIDGES
    }
    bridges = {value: count for value, count in boroughs.items() if value in KNOWN_BRIDGES}
    result.stats["boroughValueCount"] = len(boroughs)
    result.stats["boroughValuesNotABorough"] = sum(not_a_borough.values())
    for value, count in sorted(not_a_borough.items()):
        result.note_drift(
            f"borough value {value!r} x{count} is neither a NYC borough nor a known "
            f"bridge group (known bridges: {sorted(KNOWN_BRIDGES)}); it is published "
            "verbatim rather than mapped to a borough"
        )
    if bridges:
        result.warn(
            f"{sum(bridges.values())} site(s) carry a bridge group in `borough` "
            f"({C.compact_json(dict(sorted(bridges.items())))}) rather than a borough; "
            "this is DOT's column, published as-is"
        )

    # 5. `iex`, which becomes a boolean. An unknown value here is unsafe:
    # False would be a claim about a site the source did not make.
    index_values: dict[str, int] = {}
    for row in raw_rows:
        value = C.normalise_text(row.get("iex"))
        index_values[value or "<empty>"] = index_values.get(value or "<empty>", 0) + 1
    for value, count in sorted(index_values.items()):
        if value not in KNOWN_INDEX_VALUES:
            result.error(
                f"iex value {value!r} x{count} is not one of {sorted(KNOWN_INDEX_VALUES)}; "
                "inPedestrianVolumeIndex would be a guess"
            )


def check_size(path: Path, budget: int, label: str, result: Result) -> None:
    try:
        size = path.stat().st_size
    except OSError as exc:
        result.error(f"cannot stat {label} at {path}: {exc}")
        return
    result.stats[f"{label}Bytes"] = size
    if size > budget:
        result.error(
            f"{label} is {size:,} bytes, over the {budget:,}-byte budget; the artifact has "
            "stopped being a summary of the source and should be redesigned, not raised"
        )


# --------------------------------------------------------------------------- geojson


def check_feature(feature: Any, index: int, result: Result, seen: dict[str, int]) -> dict:
    where = f"feature[{index}]"
    if not isinstance(feature, dict):
        result.error(f"{where} is {js_kind(feature)}, expected an object")
        return {}
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
        return {}

    # The contract is exact: a missing property is a broken reader, and an extra
    # one is a field the pipeline invented without moving the TypeScript side.
    for name in C.HISTORY_PROPERTY_ORDER:
        if name not in properties:
            result.error(f"{where}.properties is missing {name!r}")
    for name in properties:
        if name not in C.HISTORY_PROPERTY_ORDER:
            result.error(
                f"{where}.properties has unexpected key {name!r}; HistoricalProperties in "
                "src/types/walk.ts does not declare it"
            )
    for name, allowed in C.HISTORY_PROPERTY_TYPES.items():
        if name not in properties:
            continue
        kind = js_kind(properties[name])
        if kind not in allowed:
            result.error(f"{where}.properties.{name} is {kind}, expected one of {list(allowed)}")
        if kind == "number" and not float(properties[name]).is_integer():
            result.error(f"{where}.properties.{name} is {properties[name]!r}, not an integer")

    for period in C.HISTORY_PERIODS:
        value = properties.get(period)
        if isinstance(value, int) and not isinstance(value, bool) and value < 0:
            result.error(f"{where}.properties.{period} is {value}; a count cannot be negative")

    site_id = properties.get("id")
    if isinstance(site_id, str):
        if not C.HISTORY_ID_RE.match(site_id):
            result.error(
                f"{where} id {site_id!r} does not match {C.HISTORY_ID_RE.pattern} "
                "(wsh- + 12 lowercase hex)"
            )
        if site_id in seen:
            result.error(f"duplicate id {site_id!r} at features {seen[site_id]} and {index}")
        else:
            seen[site_id] = index
        if feature.get("id") != site_id:
            result.error(f"{where}.id {feature.get('id')!r} != properties.id {site_id!r}")

    trend = properties.get("trend")
    if isinstance(trend, str) and trend not in C.TREND_STATES:
        result.error(
            f"{where}.properties.trend is {trend!r}, expected one of {list(C.TREND_STATES)}"
        )

    # `total` is the sum of the three periods AT THE LATEST SURVEY. If it does
    # not add up, one of the three has drifted out of step with it, which is
    # the failure mode that turns a day's volume into three different days.
    parts = [properties.get(period) for period in C.HISTORY_PERIODS]
    present = [part for part in parts if isinstance(part, int) and not isinstance(part, bool)]
    total = properties.get("total")
    if present and not isinstance(total, int):
        result.error(
            f"{where}.properties.total is {js_kind(total)} but {len(present)} period(s) have "
            "counts, so a total exists"
        )
    elif present:
        if sum(present) != total:
            result.error(
                f"{where}.properties.total is {total} but "
                + " + ".join(str(part) for part in present)
                + f" = {sum(present)}"
            )
    elif total is not None:
        result.error(f"{where}.properties.total is {total} but no period has a count")

    # `change`, `changeYears` and `trend` are one statement. They may not
    # disagree: a null change with a "rising" trend, or a change with no span
    # to attribute it to, is a claim the artifact cannot support.
    change = properties.get("change")
    change_years = properties.get("changeYears")
    if change is None and change_years is not None:
        result.error(f"{where} change is null but changeYears is {change_years!r}")
    if change is not None:
        if change_years is None:
            result.error(f"{where} change is {change} but changeYears is null")
        elif not isinstance(change_years, str) or "–" not in change_years:
            result.error(
                f"{where} changeYears {change_years!r} should read as "
                "'<first survey> – <last survey>'"
            )
    if trend == "insufficient" and change is not None:
        result.error(f"{where} trend is 'insufficient' but change is {change}")
    if change is None and trend != "insufficient":
        result.error(
            f"{where} trend is {trend!r} but change is null; a trend with no comparable pair "
            "is 'insufficient'"
        )

    years = [properties.get("firstYear"), properties.get("lastYear")]
    if all(isinstance(year, int) for year in years) and years[0] > years[1]:
        result.error(f"{where} firstYear {years[0]} is after lastYear {years[1]}")
    measured = properties.get("yearsMeasured")
    if isinstance(measured, int) and isinstance(years[0], int) and measured < 1:
        result.error(f"{where} yearsMeasured is {measured} but firstYear is {years[0]}")

    latest = properties.get("latestSurvey")
    if present and latest is None:
        result.error(f"{where} has counts but latestSurvey is null")
    if latest is not None and not present:
        result.error(f"{where} latestSurvey is {latest!r} but no period has a count")

    return properties


def check_geojson(geojson: Any, result: Result) -> list[dict]:
    if not isinstance(geojson, dict):
        result.error(f"historical-locations.geojson must be a JSON object, got {js_kind(geojson)}")
        return []
    if geojson.get("type") != "FeatureCollection":
        result.error(
            f"historical-locations.geojson type is {geojson.get('type')!r}, expected 'FeatureCollection'"
        )
    features = geojson.get("features")
    if not isinstance(features, list):
        result.error("historical-locations.geojson features must be an array")
        return []

    seen: dict[str, int] = {}
    properties: list[dict] = []
    for index, feature in enumerate(features):
        found = check_feature(feature, index, result, seen)
        if found:
            properties.append(found)

    if not features:
        result.error("historical-locations.geojson has no features; refusing to certify an empty dataset")

    trends: dict[str, int] = {state: 0 for state in C.TREND_STATES}
    boroughs: dict[str, int] = {}
    in_index = 0
    for item in properties:
        trends[item.get("trend")] = trends.get(item.get("trend"), 0) + 1
        boroughs[item.get("borough")] = boroughs.get(item.get("borough"), 0) + 1
        if item.get("inPedestrianVolumeIndex") is True:
            in_index += 1

    result.stats.update(
        locationCount=len(features),
        uniqueIds=len(seen),
        trends=trends,
        boroughs=dict(sorted(boroughs.items())),
        inPedestrianVolumeIndex=in_index,
    )
    return features


# --------------------------------------------------------------------------- patterns


def check_patterns(document: Any, features: list[dict], result: Result) -> None:
    if not isinstance(document, dict):
        result.error(f"historical-patterns.json must be a JSON object, got {js_kind(document)}")
        return
    for key in (
        "datasetId",
        "attribution",
        "generatedAt",
        "contentHash",
        "measurement",
        "interpolation",
        "periodLabels",
        "siteCount",
        "sites",
    ):
        if key not in document:
            result.error(f"historical-patterns.json is missing {key!r}")
    if document.get("interpolation") != "none":
        result.error(
            f"historical-patterns.json interpolation is {document.get('interpolation')!r}, "
            "expected 'none'; the source measured two or three times a year and nothing here "
            "may imply otherwise"
        )
    if document.get("siteCount") != len(features):
        result.error(
            f"historical-patterns.json siteCount {document.get('siteCount')!r} != "
            f"{len(features)} features in historical-locations.geojson"
        )

    sites = document.get("sites")
    if not isinstance(sites, dict):
        result.error("historical-patterns.json sites must be an object keyed by site id")
        return
    if list(sites) != sorted(sites):
        result.error("historical-patterns.json sites must be sorted by id for deterministic output")

    published = {
        feature["properties"]["id"] for feature in features if isinstance(feature, dict)
    }
    for missing in sorted(published - set(sites)):
        result.error(f"historical-patterns.json has no series for published site {missing!r}")
    for extra in sorted(set(sites) - published):
        result.error(f"historical-patterns.json has a series for {extra!r}, which is not published")

    total_surveys = 0
    for site_id, entry in sites.items():
        where = f"sites[{site_id!r}]"
        if not isinstance(entry, dict):
            result.error(f"{where} is {js_kind(entry)}, expected an object")
            continue
        if entry.get("discrete") is not True:
            result.error(
                f"{where}.discrete is {entry.get('discrete')!r}; the source measured discrete "
                "surveys and the UI must not be left to assume a continuous series"
            )
        surveys = entry.get("surveys")
        if not isinstance(surveys, list):
            result.error(f"{where}.surveys must be an array")
            continue
        if entry.get("surveyCount") != len(surveys):
            result.error(
                f"{where}.surveyCount {entry.get('surveyCount')!r} != {len(surveys)} surveys"
            )
        total_surveys += len(surveys)
        previous: tuple[int, int] | None = None
        for index, survey in enumerate(surveys):
            at = f"{where}.surveys[{index}]"
            if not isinstance(survey, dict):
                result.error(f"{at} is {js_kind(survey)}, expected an object")
                continue
            for key in ("year", "month", "label", "am", "md", "pm", "total", "complete"):
                if key not in survey:
                    result.error(f"{at} is missing {key!r}")
            year, month = survey.get("year"), survey.get("month")
            if not isinstance(year, int) or not isinstance(month, int):
                result.error(f"{at} needs integer year and month")
                continue
            if (previous is not None) and (year, month) <= previous:
                result.error(f"{at} ({year}-{month:02d}) is not after the previous survey")
            previous = (year, month)
            if survey.get("label") != C.survey_label(year, month):
                result.error(
                    f"{at}.label is {survey.get('label')!r}, expected {C.survey_label(year, month)!r}"
                )
            parts = [
                survey.get(period)
                for period in C.HISTORY_PERIODS
                if isinstance(survey.get(period), int) and not isinstance(survey.get(period), bool)
            ]
            if not parts:
                result.error(f"{at} has no period with a count; it is not an observation")
                continue
            if survey.get("total") != sum(parts):
                result.error(
                    f"{at}.total is {survey.get('total')!r} but the measured periods sum to {sum(parts)}"
                )
            complete = len(parts) == len(C.HISTORY_PERIODS)
            if survey.get("complete") is not complete:
                result.error(
                    f"{at}.complete is {survey.get('complete')!r} but {len(parts)} of "
                    f"{len(C.HISTERY_PERIODS)} periods have counts"
                )
            for period in C.HISTORY_PERIODS:
                value = survey.get(period)
                if value is None:
                    continue
                if not isinstance(value, int) or isinstance(value, bool) or value < 0:
                    result.error(f"{at}.{period} is {value!r}; expected a non-negative integer or null")

    result.stats["patternSites"] = len(sites)
    result.stats["patternSurveys"] = total_surveys


# --------------------------------------------------------------------------- report


def check_report(document: Any, features: list[dict], result: Result) -> None:
    if not isinstance(document, dict):
        result.error(f"report.json must be a JSON object, got {js_kind(document)}")
        return
    if "history" not in document:
        result.error(
            "report.json is missing the top-level 'history' key; this half namespaces its "
            "report under it so the two halves merge without a shared top-level key"
        )
        return

    # This half's report lives under the single top-level key "history", which
    # is what makes the merged report a `{**yours, **theirs}`. Unwrap it here
    # and check the half's own keys as if it were the whole file — the
    # namespacing must not weaken a single check.
    report = document["history"]
    if not isinstance(report, dict):
        result.error(
            f"report.json history is {js_kind(report)}, expected an object; this half's "
            "report is namespaced under \"history\" so the sensor half's can merge with it"
        )
        return

    for key in (
        "sourceRows",
        "publishedLocations",
        "rejected",
        "rejections",
        "trends",
        "boroughs",
        "pipeline",
        "contentHash",
        "generatedAt",
    ):
        if key not in report:
            result.error(f"report.json history is missing {key!r}")

    if isinstance(report.get("publishedLocations"), int) and report["publishedLocations"] != len(features):
        result.error(
            f"report.publishedLocations {report['publishedLocations']} != {len(features)} features"
        )
    if isinstance(report.get("sourceRows"), int):
        rejected = report.get("rejected")
        if isinstance(rejected, dict) and all(isinstance(v, int) for v in rejected.values()):
            if report["sourceRows"] - sum(rejected.values()) != len(features):
                result.error(
                    f"report arithmetic: {report['sourceRows']} source rows - {sum(rejected.values())} "
                    f"rejected != {len(features)} published"
                )
    rejections = report.get("rejections")
    if isinstance(rejections, list):
        counts: dict[str, int] = {}
        for index, item in enumerate(rejections):
            if not isinstance(item, dict):
                result.error(f"report.rejections[{index}] is not an object")
                continue
            for key in ("loc", "street", "borough", "latitude", "longitude", "reason"):
                if key not in item:
                    result.error(f"report.rejections[{index}] is missing {key!r}")
            reason = str(item.get("reason", ""))
            code = reason.split(":")[0].strip()
            if code not in REJECTION_PRECEDENCE:
                result.error(
                    f"report.rejections[{index}] reason {reason!r} does not start with a known "
                    f"rejection code {list(REJECTION_PRECEDENCE)}"
                )
            counts[code] = counts.get(code, 0) + 1
        rejected = report.get("rejected")
        if isinstance(rejected, dict):
            for code in REJECTION_PRECEDENCE:
                if rejected.get(code) != counts.get(code, 0):
                    result.error(
                        f"report.rejected.{code} is {rejected.get(code)!r} but {counts.get(code, 0)} "
                        f"rejections carry reason {code!r}"
                    )

    trends = report.get("trends")
    if isinstance(trends, dict) and trends != result.stats.get("trends"):
        result.error(
            f"report.trends {C.compact_json(trends)} != {C.compact_json(result.stats.get('trends', {}))} "
            "observed in historical-locations.geojson"
        )


# --------------------------------------------------------------------------- entry point


def validate(
    *,
    geojson_path: Path | None = None,
    patterns_path: Path | None = None,
    report_path: Path | None = None,
    raw_path: Path | None = None,
    min_locations: int = MIN_EXPECTED_LOCATIONS,
) -> Result:
    result = Result()
    paths = {
        "geojson": geojson_path or C.HISTORICAL_GEOJSON_PATH,
        "patterns": patterns_path or C.HISTORICAL_PATTERNS_PATH,
        "report": report_path or C.WALK_REPORT_PATH,
        "raw": raw_path or C.HISTORY_RAW_PATH,
    }
    for label in ("geojson", "patterns", "report", "raw"):
        if not paths[label].exists():
            result.error(f"missing {label} artifact: {paths[label]}")
    if result.errors:
        return result

    try:
        geojson = C.read_json_file(paths["geojson"])
        patterns = C.read_json_file(paths["patterns"])
        report = C.read_json_file(paths["report"])
        raw_rows = C.load_raw_rows(paths["raw"])
    except C.DataError as exc:
        result.error(str(exc))
        return result

    check_size(paths["geojson"], MAX_GEOJSON_BYTES, "geojson", result)
    check_size(paths["patterns"], MAX_PATTERNS_BYTES, "patterns", result)

    check_source_drift(raw_rows, report, result)
    features = check_geojson(geojson, result)
    check_patterns(patterns, features, result)
    check_report(report, features, result)

    if len(features) < min_locations:
        result.error(
            f"record count collapse: {len(features)} locations, expected at least {min_locations} "
            "(2026-09-28 measured 114)"
        )

    digest = C.content_hash(features)
    for label, value in (
        (
            "report.history.contentHash",
            report.get("history", {}).get("contentHash")
            if isinstance(report, dict) and isinstance(report.get("history"), dict)
            else None,
        ),
        (
            "historical-patterns.contentHash",
            patterns.get("contentHash") if isinstance(patterns, dict) else None,
        ),
    ):
        if value != digest:
            result.error(f"{label} {value!r} != sha256 over the published features {digest!r}")
    result.stats["contentHash"] = digest

    # The report is also cross-checked against the fetch meta, but ONLY when the
    # snapshot being validated is the canonical one. Validating an explicit
    # --raw against the canonical meta would compare a fixture's row count with
    # the real snapshot's, and fail for a reason that has nothing to do with the
    # artifact under test. Same rule as transform.verify_raw_snapshot.
    if raw_path is not None and raw_path.resolve() != C.HISTORY_RAW_PATH.resolve():
        return result
    half = report.get("history") if isinstance(report, dict) else None
    if isinstance(half, dict) and isinstance(half.get("sourceRows"), int):
        meta = C.read_fetch_meta(C.HISTORY_META_PATH) or {}
        if isinstance(meta.get("rowCount"), int) and meta["rowCount"] != half["sourceRows"]:
            result.error(
                f"report.history.sourceRows {half['sourceRows']} != history-fetch-meta.rowCount "
                f"{meta['rowCount']}; the report and the snapshot disagree"
            )
    return result


def format_result(result: Result) -> str:
    stats = result.stats
    lines = ["VALIDATION — historical-locations.geojson / historical-patterns.json"]
    if stats:
        lines.append(
            f"  locations {stats.get('locationCount')}   unique ids {stats.get('uniqueIds')}"
            f"   in the Pedestrian Volume Index {stats.get('inPedestrianVolumeIndex')}"
        )
        lines.append(f"  trends    {C.compact_json(stats.get('trends', {}))}")
        lines.append(
            f"  boroughs  {C.compact_json(stats.get('boroughs', {}))}  "
            f"({stats.get('boroughValueCount')} distinct value(s), "
            f"{stats.get('boroughValuesNotABorough', 0)} site(s) not a borough)"
        )
        lines.append(
            f"  patterns  {stats.get('patternSites')} sites / {stats.get('patternSurveys')} surveys"
        )
        lines.append(
            f"  size      geojson {stats.get('geojsonBytes', 0):,} B "
            f"(budget {MAX_GEOJSON_BYTES:,})   patterns {stats.get('patternsBytes', 0):,} B "
            f"(budget {MAX_PATTERNS_BYTES:,})"
        )
        lines.append(f"  hash      {stats.get('contentHash')}")
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
    parser.add_argument("--geojson", type=Path, default=None)
    parser.add_argument("--patterns", type=Path, default=None)
    parser.add_argument("--report", type=Path, default=None)
    parser.add_argument("--raw", type=Path, default=None)
    parser.add_argument(
        "--strict", action="store_true", help="treat schema-drift warnings as failures (for CI)"
    )
    parser.add_argument(
        "--min-locations",
        type=int,
        default=MIN_EXPECTED_LOCATIONS,
        help=f"fail below this location count (default {MIN_EXPECTED_LOCATIONS})",
    )
    args = parser.parse_args(argv)
    try:
        result = validate(
            geojson_path=args.geojson,
            patterns_path=args.patterns,
            report_path=args.report,
            raw_path=args.raw,
            min_locations=args.min_locations,
        )
    except C.PipelineError as exc:
        print(f"walk/history/validate: {exc}", file=sys.stderr)
        return 1

    print(format_result(result))
    if result.errors:
        return 1
    if args.strict and result.warnings:
        print(
            f"walk/history/validate: --strict and {len(result.warnings)} drift warning(s)",
            file=sys.stderr,
        )
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
