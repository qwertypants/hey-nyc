#!/usr/bin/env python3
"""Raw DOT screenline counts -> the two published historical artifacts.

    data/raw/walk/biannual-cqsj-cfgu.json
        -> public/data/walk/historical-locations.geojson   one feature per site
        -> public/data/walk/historical-patterns.json       that site's surveys

`build(rows, ...)` is pure — it touches no disk and takes no clock reading
other than the ones it is handed, so a test can assert byte-identical output
from a reordered fixture. `write_artifacts(outcome, ...)` does the IO. That
split is the same one `scripts/clean_data.py` uses, for the same reason.

WHAT THIS PROGRAM MEASURED
==========================
DOT counts pedestrians by hand on a screenline, in three periods (morning,
midday, evening), two or three times a year, at 114 fixed sites. It is a
two-hour sample of a couple of days, not a census and not a counter. Three
consequences are baked into every rule below and must not be "simplified" away
by a later change:

1. ABSENCE IS NOT ZERO. A site not surveyed in 2019, or surveyed in the
   morning only, has NO value for the periods it was not measured. Every such
   cell is null. `C.parse_count` already draws that line; nothing here may
   substitute a 0 for a missing observation.

2. SURVEYS ARE DISCRETE. There is no data between May 2018 and May 2019 at
   these sites other than the counts at those two points. Nothing here
   interpolates, averages or smooths, and the patterns artifact says so in
   the file so the UI cannot invent a line between two dots by accident.

3. A MONTH IS PART OF THE MEASUREMENT. See the `change` recipe below.

NEVER COMBINE WITH THE AUTOMATED PROGRAM
========================================
`ct66-47at` / `6up2-gnw8` count continuously, 15 minutes at a time, at four
counters. This program counts by hand, twice a year, at 114 sites. The two are
never summed, differenced or presented as the same measurement. The
`HistoricalProperties` docstring in src/types/walk.ts says so too; both sides
change together.

Usage:
    python3 scripts/walk/history/transform.py [--raw PATH] [--geojson PATH]
        [--patterns PATH] [--report PATH] [--quiet]
"""

from __future__ import annotations

import argparse
import collections
import hashlib
import re
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import _common as C  # noqa: E402

# --------------------------------------------------------------------------- rules
#
# `change` — WHY IT IS SO NARROW
# ==============================
# The obvious recipe is "total at the most recent survey, minus total at the
# first". It is wrong, and it is wrong in a way that produces a beautifully
# confident lie.
#
# The surveys are not evenly spaced in the calendar. The program surveyed in
# May and September from 2007, added October from 2020, skipped 2018->2020
# entirely, surveyed 2024 in JUNE as well as October, and moved to May in 2025.
# So "first survey to last survey" is a May-to-May comparison on some sites and
# a May-to-October comparison on others — and a May-to-October difference is
# mostly a statement about what month New Yorkers walk outside, not about
# whether the street got busier. On these corridors the seasonal swing is the
# same order of magnitude as the multi-year trend being claimed, so a
# season-mismatched difference is a seasonal artefact wearing a trend's label.
#
# Therefore `change` is computed only when BOTH:
#
#   * the first and last surveys in the comparison month have ALL THREE
#     periods populated — a morning-only survey is not a day's volume and must
#     not stand in for one; and
#   * the two endpoints share a calendar month.
#
# The comparison month is the month of the site's FIRST complete survey, not
# whichever month produces the largest difference. Choosing the month that
# maximises the gap would manufacture a trend out of seasonal noise, which is
# the exact failure this rule exists to prevent.
#
# Anything else is null, and null is published as null.
#
# `trend` reads `change` and nothing else, so the two can never disagree.

#: En dash, not a hyphen: the span reads as a range, and `latestSurvey` uses
#: the same wording so a reader can match the two by eye.
SPAN_DASH = "–"

#: A comparison shorter than this is not a trend, it is two surveys. It also
#: happens to exclude the 2018 -> 2021 gap, which is dominated by the pandemic
#: closure and says more about 2020 than about the street.
MIN_TREND_SPAN_YEARS = 5

#: `flat` band, as a fraction of the FIRST survey's total.
#:
#: Derived from the live data, not chosen for tidiness. Across 3,421 pairs of
#: adjacent same-month, all-three-periods surveys in `cqsj-cfgu` (measured
#: 2026-09-28), the median absolute year-over-year change is 13.1% and the
#: 75th percentile is 27.1% — a hand-counted two-hour screenline sample is
#: noisy, and adjacent surveys routinely disagree by more than 10%. A flat
#: band below that median would label sampling noise as a direction of travel.
#: 15% sits just above the median single-interval wobble, and over a span of
#: this length the real multi-year signal is comfortably larger than it.
TREND_FLAT_BAND_FRACTION = 0.15

#: Rejection precedence. A row that breaks more than one rule is recorded once,
#: under the first rule it breaks, in this order. Geometry leads: a site with
#: no point cannot be published, whatever else it has.
REJECTION_PRECEDENCE = (
    "missing_identity",
    "missing_geometry",
    "unsupported_geometry",
    "unparseable_coordinates",
    "out_of_bounds",
)

#: `borough` is NOT validated as a NYC borough, and the reason is worth stating
#: where the value is published rather than only in the validator.
#:
#: It is a source LOCATION DESCRIPTOR that sometimes names a waterway rather than
#: a borough. As of 2026-09-28, 19 of 114 sites carry "Harlem River Bridges"
#: (9), "East River Bridges" (5) or a truncated "Staten Isla" (5, on all five
#: Staten Island sites).
#:
#: We publish it VERBATIM, for two reasons, and both are load-bearing:
#:
#:   * Rejecting it would drop 19 sites of real hand-counted screenline data on
#:     real bridges, over a naming problem.
#:   * Mapping it to a borough would require a bridge-to-borough table that the
#:     city never published, so every row of that table would be a guess
#:     presented as a citation. There is no second column in the dataset to
#:     resolve the bridges against, and no other NYC Open Data layer this
#:     pipeline reads that does so. Inventing one is the failure this project
#:     exists to avoid.
#:
#: Nothing here keys on the literal string of a known-odd value, so a future
#: correction (e.g. "Staten Isla" becoming "Staten Island") publishes cleanly
#: and the counter simply moves. `validate.py` warns about every value that is
#: neither one of the five boroughs nor a known bridge group, and reports the
#: count of distinct values so the drift is visible in a refresh log.

#: Counters that cannot be derived from the published features, so that a
#: normalisation or a drift can never happen quietly.
PIPELINE_KEYS = (
    "whitespaceCollapsed",
    "nullishText",
    "unparseableOrNegativeCountCells",
    "zeroCountCells",
    "nullCountCells",
    "surveysWithNoCounts",
    "partialSurveys",
    "crossStreetFromToStreet",
    "missingCrossStreet",
    "midpointCrossStreet",
    "nonBoroughBoroughValues",
    "duplicateSiteIds",
    "changeInsufficientIncomplete",
    "changeInsufficientSingleSurvey",
    "changeInsufficientShortSpan",
    "changeInsufficientZeroBaseline",
    "trendRising",
    "trendFalling",
    "trendFlat",
    "trendInsufficient",
)

#: How the `name` is built, and why nothing more clever is attempted.
#:
#: The source's street strings are not in any canonical form: "West 231st
#: Street", "W 231st Street", "Gra Concourse", "Gra Street", "Fresh Po Road",
#: "Nostra Avenue" (a typo for Nostrand), "Uerhill Avenue", "52 Street", "71st
#: Ave", "70th Road". There is no abbreviation table in the dataset and no
#: second column to resolve them against. Expanding them would mean inventing a
#: street-naming authority the city never published, and every expansion would
#: be a guess that reads as a citation. So: `street` verbatim, `at crossStreet`
#: verbatim, whitespace collapsed, nothing else. A reader who wants "W 231st" to
#: match "West 231st" has to see both spellings; that is the honest outcome.
#:
#: Cross street is `from_stree` when populated, else `to_street`. Where both are
#: empty the feature publishes just the street. For the 14 bridge and greenway
#: sites DOT spells the cross street "midpoint"; that is published as-is
#: ("Williamsburg Bridge at midpoint") rather than special-cased, and counted
#: in report.pipeline.midpointCrossStreet so a reader knows it is DOT's wording
#: and not a parsing accident.

#: Detector for a column that LOOKS like a survey count column, whatever its
#: period token. This is deliberately BROADER than `C.HISTORY_COLUMN_RE`, which
#: is the parser: the difference between the two is the schema-drift check.
#:
#: The live source spells the PM period two different ways in the same row
#: (`may_22_pm` and `may_22_p_m`), so the parser's period token is a
#: canonicalisation and not a fixed string — which is exactly why a
#: shape-detector that ignores the token is the only thing standing between a
#: FOURTH spelling and silent data loss. A parser that grew to accept every
#: spelling that has ever occurred is not evidence that the next one will be
#: handled; this regex is. See validate.py.
COUNT_COLUMN_SHAPE_RE = re.compile(r"^(may|sept|oct|june)_?\d{2}_")

#: The source spells its cross-street columns `from_stree` and `to_street`.
#: `from_stree` is a typo for `from_street` in the Socrata column name, and it
#: is the name that has been stable across every refresh, so it stays.
FROM_COLUMN = "from_stree"
TO_COLUMN = "to_street"


@dataclass
class Outcome:
    features: list[dict]
    patterns: dict
    report: dict
    rejections: list[dict]
    pipeline: dict
    content_hash: str


@dataclass
class Site:
    """One source row, normalised. `survey` entries are chronological."""

    loc: str | None
    street: str | None
    cross_street: str | None
    borough: str | None
    in_index: bool
    latitude: float | None
    longitude: float | None
    survey: list[dict] = field(default_factory=list)
    source: dict = field(repr=False, default_factory=dict)


# --------------------------------------------------------------------------- columns


def count_column_names(rows: Iterable[dict]) -> set[str]:
    """Every column in any row that SHAPES like a survey count column.

    Broader than the parser on purpose — see COUNT_COLUMN_SHAPE_RE.
    """
    names: set[str] = set()
    for row in rows:
        names.update(column for column in row if COUNT_COLUMN_SHAPE_RE.match(column))
    return names


def parsed_column_names(rows: Iterable[dict]) -> set[str]:
    """Every column `C.history_columns` actually consumed.

    If this is smaller than `count_column_names`, the parser is behind the
    source and the difference is data loss, not a no-op.
    """
    names: set[str] = set()
    for row in rows:
        names.update(descriptor["column"] for descriptor in C.history_columns(row))
    return names


# --------------------------------------------------------------------------- normalise


def _changed(before: Any, after: str | None) -> bool:
    raw = "" if before is None else before
    return isinstance(raw, str) and raw != (after or "")


def point_of(row: dict) -> tuple[float | None, float | None, str | None]:
    """`the_geom` -> (lat, lon, failure_code). failure_code is None on success."""
    geometry = row.get("the_geom")
    if geometry is None:
        return None, None, "missing_geometry"
    if not isinstance(geometry, dict):
        return None, None, "unsupported_geometry"
    if geometry.get("type") != "Point":
        return None, None, "unsupported_geometry"
    coordinates = geometry.get("coordinates")
    if not isinstance(coordinates, list) or len(coordinates) != 2:
        return None, None, "unparseable_coordinates"
    lon = C.parse_coordinate(coordinates[0])
    lat = C.parse_coordinate(coordinates[1])
    if lat is None or lon is None:
        return None, None, "unparseable_coordinates"
    if not C.in_nyc_bbox(lat, lon):
        return None, None, "out_of_bounds"
    return lat, lon, None


def cross_street_of(row: dict) -> str | None:
    """`from_stree` when populated, else `to_street`, else None."""
    return C.normalise_text(row.get(FROM_COLUMN)) or C.normalise_text(row.get(TO_COLUMN))


def name_of(street: str, cross_street: str | None) -> str:
    """`street` + ` at ` + `crossStreet`. See the recipe note above the rules."""
    return f"{street} at {cross_street}" if cross_street else street


def surveys_of(row: dict, counters: collections.Counter) -> list[dict]:
    """Every survey on a row, chronological, with an explicit null per period.

    A survey is a (year, month) pair; the three periods are independent. A
    survey with no count at all is counted and dropped rather than published as
    three nulls, because it is not an observation and publishing it as one
    would put a dot on the chart where DOT stood and wrote nothing.
    """
    grouped: dict[tuple[int, int], dict[str, int | None]] = {}
    columns: dict[tuple[int, int], set[str]] = collections.defaultdict(set)
    for descriptor in C.history_columns(row):
        key = (descriptor["year"], descriptor["month"])
        grouped.setdefault(key, {period: None for period in C.HISTORY_PERIODS})
        columns[key].add(descriptor["column"])
        value = descriptor["value"]
        if value is not None:
            grouped[key][descriptor["period"]] = value

    surveys: list[dict] = []
    for (year, month) in sorted(grouped):
        periods = grouped[(year, month)]
        present = [periods[period] for period in C.HISTORY_PERIODS]
        if all(value is None for value in present):
            counters["surveysWithNoCounts"] += 1
            continue
        if any(value is None for value in present):
            counters["partialSurveys"] += 1
        surveys.append(
            {
                "year": year,
                "month": month,
                "label": C.survey_label(year, month),
                "am": periods["am"],
                "md": periods["md"],
                "pm": periods["pm"],
                "total": sum(value for value in present if value is not None),
                "complete": all(value is not None for value in present),
                "columns": sorted(columns[(year, month)]),
            }
        )
    return surveys


def count_cells_of(row: dict, counters: collections.Counter) -> None:
    """Tally every parsed count cell, including the ones that became None.

    `C.parse_count` maps absent, unparseable and negative to None, which is the
    right answer for the artifact and the wrong answer for a report: a cell
    that read "-3" is a fact about the source and must be counted here, not
    dissolved into a null.
    """
    for descriptor in C.history_columns(row):
        raw = row.get(descriptor["column"])
        if raw is None or (isinstance(raw, str) and not raw.strip()):
            counters["nullCountCells"] += 1
        elif descriptor["value"] is None:
            counters["unparseableOrNegativeCountCells"] += 1
        elif descriptor["value"] == 0:
            counters["zeroCountCells"] += 1


def normalise_site(row: dict, counters: collections.Counter) -> Site:
    """Whitespace and nullish normalisation, and the cross-street choice."""
    for column in ("street_nam", FROM_COLUMN, TO_COLUMN, "borough", "loc", "iex"):
        before = row.get(column)
        after = C.normalise_text(before)
        if _changed(before, after):
            counters["nullishText" if after is None else "whitespaceCollapsed"] += 1

    cross = cross_street_of(row)
    if cross is None:
        counters["missingCrossStreet"] += 1
    elif C.normalise_text(row.get(FROM_COLUMN)) is None:
        counters["crossStreetFromToStreet"] += 1
    if cross is not None and cross.lower() == "midpoint":
        counters["midpointCrossStreet"] += 1

    lat, lon, _ = point_of(row)
    count_cells_of(row, counters)
    return Site(
        loc=C.normalise_text(row.get("loc")),
        street=C.normalise_text(row.get("street_nam")),
        cross_street=cross,
        borough=C.normalise_text(row.get("borough")),
        in_index=C.normalise_text(row.get("iex")) == "Y",
        latitude=lat,
        longitude=lon,
        survey=surveys_of(row, counters),
        source=row,
    )


# --------------------------------------------------------------------------- validate


def describe(site: Site, code: str) -> str:
    if code == "missing_identity":
        return "loc and street_nam are both empty, so there is no stable id to publish"
    if code == "missing_geometry":
        return "the_geom is absent; the site has no point to put on the map"
    if code == "unsupported_geometry":
        return f"the_geom is {C.compact_json(site.source.get('the_geom'))[:80]}, expected a GeoJSON Point"
    if code == "unparseable_coordinates":
        geometry = site.source.get("the_geom")
        coordinates = geometry.get("coordinates") if isinstance(geometry, dict) else geometry
        return (
            f"the_geom.coordinates is {C.compact_json(coordinates)}, expected two numbers"
        )
    if code == "out_of_bounds":
        return (
            f"{site.latitude},{site.longitude} is outside the NYC bounding box "
            f"lat[{C.LAT_MIN},{C.LAT_MAX}] lng[{C.LNG_MIN},{C.LNG_MAX}]"
        )
    return "rejected"


def rejection_codes(site: Site) -> list[str]:
    codes: list[str] = []
    if site.street is None or site.loc is None:
        codes.append("missing_identity")
    _, _, failure = point_of(site.source)
    if failure is not None:
        codes.append(failure)
    return sorted(codes, key=REJECTION_PRECEDENCE.index)


# --------------------------------------------------------------------------- features


def comparable_pair(site: Site, counters: collections.Counter) -> tuple[dict, dict] | None:
    """The (first, last) surveys `change` may be computed from, or None.

    See the `change` recipe at the top of this file. This function is the whole
    rule: it returns endpoints only when both are complete surveys in the SAME
    calendar month, and when the span is long enough to be a trend.
    """
    complete = [survey for survey in site.survey if survey["complete"]]
    if not complete:
        counters["changeInsufficientIncomplete"] += 1
        return None
    month = complete[0]["month"]
    same_month = [survey for survey in complete if survey["month"] == month]
    if len(same_month) < 2:
        counters["changeInsufficientSingleSurvey"] += 1
        return None
    first, last = same_month[0], same_month[-1]
    if last["year"] - first["year"] < MIN_TREND_SPAN_YEARS:
        counters["changeInsufficientShortSpan"] += 1
        return None
    if first["total"] <= 0:
        # A percentage band against a baseline of zero is not a measurement.
        counters["changeInsufficientZeroBaseline"] += 1
        return None
    return first, last


def trend_for(change: int | None, baseline: int | None) -> str:
    """`change` -> a trend bucket. Never looks at anything else.

    `insufficient` means "we could not compare", and is the only outcome when
    there is no comparable pair — the same condition that makes `change` null.
    """
    if change is None or baseline is None or baseline <= 0:
        return "insufficient"
    band = TREND_FLAT_BAND_FRACTION * baseline
    if change > band:
        return "rising"
    if change < -band:
        return "falling"
    return "flat"


def feature_of(site: Site, counters: collections.Counter) -> dict:
    """One published feature. Property order is the contract; see walk.ts."""
    cross = site.cross_street
    feature_id = C.history_id(site.loc, site.street or "", cross or "")

    # am/md/pm/total describe ONE survey — the most recent that measured
    # anything — not a best-of-across-surveys. Taking each period from its own
    # latest survey would produce a `total` that sums three different days and
    # reads as a single day's volume. `HistoricalProperties` in walk.ts says
    # these "describe one screenline survey"; this is how that holds.
    latest = site.survey[-1] if site.survey else None
    am = latest["am"] if latest else None
    md = latest["md"] if latest else None
    pm = latest["pm"] if latest else None
    total = latest["total"] if latest else None

    years = sorted({survey["year"] for survey in site.survey})
    first_year = years[0] if years else None
    last_year = years[-1] if years else None

    pair = comparable_pair(site, counters)
    if pair is None:
        change = None
        change_years = None
        baseline = None
    else:
        first, last = pair
        change = last["total"] - first["total"]
        change_years = f"{first['label']} {SPAN_DASH} {last['label']}"
        baseline = first["total"]

    trend = trend_for(change, baseline)
    counters[f"trend{trend.capitalize()}"] += 1

    if site.borough is not None and site.borough not in C.BOROUGHS:
        counters["nonBoroughBoroughValues"] += 1

    properties = {
        "id": feature_id,
        "name": name_of(site.street or "", cross),
        "street": site.street or "",
        "crossStreet": cross,
        "borough": site.borough or "",
        "inPedestrianVolumeIndex": site.in_index,
        "am": am,
        "md": md,
        "pm": pm,
        "total": total,
        "change": change,
        "changeYears": change_years,
        "firstYear": first_year,
        "lastYear": last_year,
        "yearsMeasured": len(years),
        "latestSurvey": latest["label"] if latest else None,
        "trend": trend,
    }
    assert tuple(properties) == C.HISTORY_PROPERTY_ORDER, "property order drifted from the contract"

    return {
        "type": "Feature",
        "id": feature_id,
        "geometry": {
            "type": "Point",
            "coordinates": [site.longitude, site.latitude],
        },
        "properties": properties,
    }


# --------------------------------------------------------------------------- patterns


def patterns_entry(site: Site) -> dict:
    """The per-site survey series for the detail chart.

    `discrete: true` and `interpolate: false` are not decoration. The source
    measured two or three times a year, so a straight line drawn between two
    surveys asserts a continuous record that does not exist, and a smoothed
    curve asserts one that will not be there. The chart must join points; these
    two flags say that joining points is the whole of what the data supports,
    in the file, where a reader of the JSON will meet them — not in a comment
    in a component the data never reaches.

    `complete: false` on a survey means one or two of the three periods were
    measured; the UI needs that to avoid drawing an AM-only sample as a day's
    total.
    """
    return {
        "street": site.street or "",
        "crossStreet": site.cross_street,
        "borough": site.borough or "",
        "discrete": True,
        "interpolate": False,
        "surveyCount": len(site.survey),
        "surveys": [
            {
                "year": survey["year"],
                "month": survey["month"],
                "label": survey["label"],
                "am": survey["am"],
                "md": survey["md"],
                "pm": survey["pm"],
                "total": survey["total"],
                "complete": survey["complete"],
            }
            for survey in site.survey
        ],
    }


# --------------------------------------------------------------------------- build


def build(
    raw_rows: list[dict],
    *,
    retrieved_at: str | None = None,
    source_updated_at: str | None = None,
    generated_at: str | None = None,
) -> Outcome:
    """Raw rows -> the two artifacts and the report. Pure: no IO, no clock."""
    now = C.iso_now()
    retrieved_at = retrieved_at or now
    generated_at = generated_at or now

    counters: collections.Counter = collections.Counter()
    detected = count_column_names(raw_rows)
    consumed = parsed_column_names(raw_rows)
    unhandled = sorted(detected - consumed)

    sites = [normalise_site(row, counters) for row in raw_rows]

    features: list[dict] = []
    patterns: dict[str, dict] = {}
    rejections: list[dict] = []
    rejected: collections.Counter = collections.Counter()

    for site in sites:
        codes = rejection_codes(site)
        if codes:
            code = codes[0]
            rejected[code] += 1
            rejections.append(
                {
                    "loc": site.loc,
                    "street": site.street,
                    "crossStreet": site.cross_street,
                    "borough": site.borough,
                    "latitude": site.latitude,
                    "longitude": site.longitude,
                    "reason": f"{code}: {describe(site, code)}",
                }
            )
            continue
        feature = feature_of(site, counters)
        feature_id = feature["properties"]["id"]
        if feature_id in patterns:
            # The id is sha1(loc|street|crossStreet) and `loc` is the source's
            # own site number, so this should be impossible. If it happens
            # anyway the id recipe is broken, and carrying on would drop a site
            # out of the patterns artifact without a trace. Stop instead.
            counters["duplicateSiteIds"] += 1
            raise C.DataError(
                f"loc={site.loc} street={site.street!r} crossStreet={site.cross_street!r} "
                f"collides with an earlier row on id {feature_id}; the id recipe in "
                f"scripts/walk/_common.py history_id() is not unique for this source"
            )
        features.append(feature)
        patterns[feature_id] = patterns_entry(site)

    features.sort(key=lambda feature: feature["id"])
    rejections.sort(key=lambda item: (str(item["reason"]).split(":")[0], item["loc"] or ""))

    digest = C.content_hash(features)

    pipeline: dict[str, Any] = {key: int(counters.get(key, 0)) for key in PIPELINE_KEYS}
    # The drift bookkeeping, in the report, so the drift check has something
    # to compare the live source against. See validate.py.
    pipeline["consumedCountColumns"] = len(consumed)
    pipeline["unhandledCountColumns"] = len(unhandled)
    pipeline["consumedCountColumnNames"] = sorted(consumed)
    pipeline["unhandledCountColumnNames"] = unhandled

    boroughs: collections.Counter = collections.Counter(
        feature["properties"]["borough"] for feature in features
    )
    trends = {state: 0 for state in C.TREND_STATES}
    periods = {period: 0 for period in C.HISTORY_PERIODS}
    for feature in features:
        trends[feature["properties"]["trend"]] += 1
        for period in C.HISTORY_PERIODS:
            if feature["properties"][period] is not None:
                periods[period] += 1

    pattern_document = {
        "dataset": C.HISTORY_NAME,
        "datasetId": C.HISTORY_DATASET_ID,
        "attribution": C.ATTRIBUTION,
        "source": C.SOURCES["history"]["source"],
        "provider": C.PROVIDER,
        "retrievedAt": retrieved_at,
        "sourceUpdatedAt": source_updated_at,
        "generatedAt": generated_at,
        "contentHash": digest,
        #: Read these before drawing anything. They are the reason the series
        #: is a list of dots and not a line.
        "measurement": "discrete screenline survey",
        "interpolation": "none",
        "note": (
            "Each entry is one manual screenline survey, two or three times a year, "
            "in three periods. The source did not measure between surveys, so nothing "
            "here is interpolated and a null period was never measured."
        ),
        "periodLabels": dict(C.PERIOD_LABELS),
        "trendRule": {
            "change": (
                "total at the last vs the first complete survey in the site's first "
                "survey month; null unless both endpoints have all three periods "
                "populated, share a calendar month, and span at least "
                f"{MIN_TREND_SPAN_YEARS} years"
            ),
            "flatBandFraction": TREND_FLAT_BAND_FRACTION,
            "minSpanYears": MIN_TREND_SPAN_YEARS,
        },
        "siteCount": len(patterns),
        "sites": {key: patterns[key] for key in sorted(patterns)},
    }

    # This half's report is namespaced under a single top-level key, "history",
    # so that merging it with the sensor half's report — which is namespaced
    # under "sensors" — is `{**sensor_half, **this_half}` with no shared key and
    # no possibility of one half silently overwriting the other's counters. The
    # two halves measure different things (see the top of this file), so their
    # keys are disjoint by construction; this is the mechanism that keeps it
    # that way rather than a convention somebody has to remember.
    report = {
        "history": {
            "sourceRows": len(raw_rows),
            "publishedLocations": len(features),
            "rejected": {code: int(rejected.get(code, 0)) for code in REJECTION_PRECEDENCE},
            "rejections": rejections,
            "periodsMeasured": periods,
            "trends": trends,
            "boroughs": dict(sorted(boroughs.items())),
            "boroughValueCount": len(boroughs),
            "inPedestrianVolumeIndex": sum(
                1 for feature in features if feature["properties"]["inPedestrianVolumeIndex"]
            ),
            "comparableChange": sum(
                1 for feature in features if feature["properties"]["change"] is not None
            ),
            "publishedSurveys": sum(len(entry["surveys"]) for entry in patterns.values()),
            "contentHash": digest,
            "generatedAt": generated_at,
            "pipeline": pipeline,
        }
    }

    return Outcome(
        features=features,
        patterns=pattern_document,
        report=report,
        rejections=rejections,
        pipeline=pipeline,
        content_hash=digest,
    )


# --------------------------------------------------------------------------- artifacts


def verify_raw_snapshot(path: Path) -> dict:
    """Refuse to transform the canonical snapshot if it no longer matches its meta.

    Only applies to the canonical path: an explicit --raw is a file the caller
    has taken responsibility for.
    """
    meta = C.read_fetch_meta(C.HISTORY_META_PATH) or {}
    if path.resolve() != C.HISTORY_RAW_PATH.resolve():
        return meta
    expected = meta.get("responseSha256")
    if not expected:
        return meta
    try:
        actual = hashlib.sha256(path.read_bytes()).hexdigest()
    except OSError as exc:
        raise C.DataError(f"cannot read {path}: {exc}") from exc
    if actual != expected:
        raise C.DataError(
            f"{path} does not match {C.HISTORY_META_PATH.name} "
            f"(sha256 {actual} != {expected}); re-run scripts/walk/history/fetch.py"
        )
    return meta


def write_artifacts(
    outcome: Outcome,
    *,
    geojson_path: Path | None = None,
    patterns_path: Path | None = None,
    report_path: Path | None = None,
) -> dict[str, int]:
    """Write the three files. Returns path -> bytes written."""
    written = {
        geojson_path or C.HISTORICAL_GEOJSON_PATH: C.write_json_file(
            geojson_path or C.HISTORICAL_GEOJSON_PATH,
            {"type": "FeatureCollection", "features": outcome.features},
        ),
        patterns_path or C.HISTORICAL_PATTERNS_PATH: C.write_json_file(
            patterns_path or C.HISTORICAL_PATTERNS_PATH, outcome.patterns
        ),
        report_path or C.WALK_REPORT_PATH: C.write_json_file(
            report_path or C.WALK_REPORT_PATH, outcome.report
        ),
    }
    return written


def run(
    raw_path: Path | None = None,
    *,
    geojson_path: Path | None = None,
    patterns_path: Path | None = None,
    report_path: Path | None = None,
    quiet: bool = False,
) -> Outcome:
    path = raw_path or C.HISTORY_RAW_PATH
    meta = verify_raw_snapshot(path)
    raw_rows = C.load_raw_rows(path)
    outcome = build(
        raw_rows,
        source_updated_at=meta.get("sourceUpdatedAt"),
        retrieved_at=meta.get("retrievedAt"),
    )
    write_artifacts(
        outcome,
        geojson_path=geojson_path,
        patterns_path=patterns_path,
        report_path=report_path,
    )
    if not quiet:
        print(format_summary(outcome))
    return outcome


def format_summary(outcome: Outcome) -> str:
    report = outcome.report["history"]
    pipeline = outcome.pipeline
    rejected = report["rejected"]
    lines = [
        f"  source rows           {report['sourceRows']}",
        f"  rejected              {sum(rejected.values())} ({C.compact_json(rejected)})",
        f"  published locations   {report['publishedLocations']}",
        f"  count columns         {pipeline['consumedCountColumns']} consumed"
        f", {pipeline['unhandledCountColumns']} unhandled",
    ]
    if pipeline["unhandledCountColumnNames"]:
        lines.append(
            "  UNHANDLED COLUMNS     "
            f"{', '.join(pipeline['unhandledCountColumnNames'])}"
            "  <- SCHEMA DRIFT, the parser is behind the source"
        )
    lines += [
        f"  periods measured      {C.compact_json(report['periodsMeasured'])}",
        f"  trends                {C.compact_json(report['trends'])}",
        f"  comparable change     {report['comparableChange']} of {report['publishedLocations']}",
        f"  boroughs              {C.compact_json(report['boroughs'])}",
        f"  published surveys     {report['publishedSurveys']}",
        f"  content hash          {report['contentHash']}",
        f"  partial surveys       {pipeline['partialSurveys']}"
        f"  (surveys with no counts {pipeline['surveysWithNoCounts']})",
        f"  unparseable/negative  {pipeline['unparseableOrNegativeCountCells']} cells"
        f"  (zero cells {pipeline['zeroCountCells']}, null cells {pipeline['nullCountCells']})",
        f"  non-borough values    {pipeline['nonBoroughBoroughValues']}"
        f"  (midpoint cross streets {pipeline['midpointCrossStreet']})",
    ]
    if outcome.rejections:
        lines.append("  rejections")
        for item in outcome.rejections:
            lines.append(f"    - {item['reason']}  [loc={item['loc']} / {item['street']}]")
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--raw", type=Path, default=None, help="raw snapshot to read")
    parser.add_argument(
        "--geojson", type=Path, default=None, help="where to write historical-locations.geojson"
    )
    parser.add_argument(
        "--patterns", type=Path, default=None, help="where to write historical-patterns.json"
    )
    parser.add_argument(
        "--report",
        type=Path,
        default=None,
        help=(
            "where to write report.json. NOTE: the default is data/processed/walk/report.json, "
            "which the sensor half also writes; the file this script produces is the "
            "HISTORICAL half only."
        ),
    )
    parser.add_argument("--quiet", action="store_true", help="only report failures")
    args = parser.parse_args(argv)
    try:
        run(
            raw_path=args.raw,
            geojson_path=args.geojson,
            patterns_path=args.patterns,
            report_path=args.report,
            quiet=args.quiet,
        )
    except C.PipelineError as exc:
        print(f"walk/history/transform: {exc}", file=sys.stderr)
        return 1
    print(f"  wrote {C.display_path(args.geojson or C.HISTORICAL_GEOJSON_PATH)}")
    print(f"  wrote {C.display_path(args.patterns or C.HISTORICAL_PATTERNS_PATH)}")
    print(f"  wrote {C.display_path(args.report or C.WALK_REPORT_PATH)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
