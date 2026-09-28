"""Tests for the historical half of the walk pipeline (scripts/walk/history).

No network, no repo state: every row here is an inline fixture shaped like
`cqsj-cfgu`, and anything that needs a file gets one in a tmp dir.

The spellings in `COUNT_ROWS` are the ones the live source actually publishes,
including the awkward ones:

  * `may_07_am`  — underscore, two-digit year (2007 to 2018)
  * `june_24_am` — 2024 was surveyed in June
  * `oct_20_am`  — 2020 was October only; there is no may_20
  * `may25_am`   — no underscore, unprefixed year (2025, 2026)
  * no may_19 columns at all

The source also spells the PM period two ways: `may_22_p_m` and `may_23_p_m`
appear in the live data alongside `may_22_pm`. `C.HISTORY_COLUMN_RE` now
canonicalises both onto period `pm`, so this pipeline consumes all 111 columns
and `unhandledCountColumns` is 0. That is a fact about the contract as it
stands, not a guarantee: these tests therefore exercise the drift detector with
SYNTHETIC fourth spellings, so that being taught a new spelling in `_common.py`
can never turn a regression guard into a false failure.
"""

from __future__ import annotations

import copy
import json
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
WALK_DIR = REPO_ROOT / "scripts" / "walk"
for path in (REPO_ROOT, WALK_DIR):
    if str(path) not in sys.path:
        sys.path.insert(0, str(path))

# `history` must be imported FIRST: its __init__ claims the `_common` module
# name for the walk contract, because conftest.py already claimed it for the eat
# one and Python keys sys.modules by bare name. Importing `_common` above this
# line would hand the tests the eat pipeline's contract.
from history import transform, validate  # noqa: E402

import _common as C  # noqa: E402  (now the WALK contract)

#: A row exactly as Socrata publishes it: GeoJSON point, string scalars,
#: `loc` as the stable site number, and 100-odd count columns.
BASE_ROW: dict = {
    "the_geom": {"type": "Point", "coordinates": [-73.90459140730678, 40.87919896648574]},
    "objectid": "1",
    "loc": "1",
    "borough": "Bronx",
    "street_nam": "Broadway",
    "from_stree": "West 231st Street",
    "to_street": "Naples Terrace",
    "iex": "N",
    "may_07_am": "630",
    "may_07_md": "1710",
    "may_07_pm": "3262",
    "sept_07_am": "580",
    "sept_07_md": "1600",
    "sept_07_pm": "3100",
    "may_18_am": "1271",
    "may_18_md": "2899",
    "may_18_pm": "4502",
    "oct_20_am": "500",
    "oct_20_md": "1500",
    "oct_20_pm": "2900",
    "june_24_am": "900",
    "june_24_md": "2400",
    "june_24_pm": "4300",
    "may25_am": "1000",
    "may25_md": "2500",
    "may25_pm": "4400",
    "may26_am": "1100",
    "may26_md": "2600",
    "may26_pm": "4500",
}


def make_row(loc: str = "1", **overrides) -> dict:
    """A complete source row with the given overrides applied."""
    row = copy.deepcopy(BASE_ROW)
    row["loc"] = loc
    row["objectid"] = loc
    row.update(overrides)
    return row


def only(outcome) -> dict:
    assert len(outcome.features) == 1, f"expected one feature, got {len(outcome.features)}"
    return outcome.features[0]


def properties_of(outcome) -> dict:
    return only(outcome)["properties"]


def reasons(outcome) -> list[str]:
    return [item["reason"].split(":")[0] for item in outcome.report["history"]["rejections"]]


#: The survey column prefix the live source uses for each survey, exactly as
#: published. This map IS the exercise: the spelling changes mid-stream.
SURVEY_PREFIXES = {
    (2007, 5): "may_07",
    (2007, 9): "sept_07",
    (2018, 5): "may_18",
    (2020, 10): "oct_20",
    (2024, 6): "june_24",
    (2025, 5): "may25",
    (2026, 5): "may26",
    # Not a survey the source publishes. A test needs a short May-to-May span,
    # and there is no second May 2024 column to borrow, so this is spelled the
    # way every year up to 2023 is.
    (2024, 5): "may_24",
}


def columns_for(key: tuple[int, int]) -> tuple[str, str, str]:
    return tuple(f"{SURVEY_PREFIXES[key]}_{period}" for period in ("am", "md", "pm"))


def set_survey(row: dict, key: tuple[int, int], **periods: str) -> None:
    """Set a whole survey, spelled the way this year is spelled.

    A value of "" is a null cell; omit a period to remove the column entirely,
    which is how a site that was not surveyed looks.
    """
    for column, value in zip(columns_for(key), ("am", "md", "pm")):
        if value in periods:
            row[column] = periods[value]


def clear_survey(row: dict, key: tuple[int, int]) -> None:
    for column in columns_for(key):
        row.pop(column, None)


# --------------------------------------------------------------------------- publish


def write_all(outcome, directory: Path) -> dict[str, Path]:
    """Write the three artifacts plus the raw snapshot the validator reads."""
    directory.mkdir(parents=True, exist_ok=True)
    paths = {
        "geojson": directory / "historical-locations.geojson",
        "patterns": directory / "historical-patterns.json",
        "report": directory / "report.json",
        "raw": directory / "raw.json",
    }
    transform.write_artifacts(
        outcome,
        geojson_path=paths["geojson"],
        patterns_path=paths["patterns"],
        report_path=paths["report"],
    )
    return paths


def _tmp_dir() -> str:
    """A fresh temp directory name, for tests that need more than one."""
    import tempfile

    return tempfile.mkdtemp(prefix="walk-history-")


def check(rows: list[dict], directory: Path, **kwargs) -> validate.Result:
    """Build from `rows`, write everything to `directory`, validate it there."""
    outcome = transform.build(
        rows, generated_at="2026-09-28T00:00:00Z", retrieved_at="2026-09-28T00:00:00Z"
    )
    paths = write_all(outcome, directory)
    C.write_json_file(paths["raw"], rows)
    return validate.validate(
        geojson_path=paths["geojson"],
        patterns_path=paths["patterns"],
        report_path=paths["report"],
        raw_path=paths["raw"],
        min_locations=kwargs.pop("min_locations", 0),
        **kwargs,
    )


# --------------------------------------------------------------------------- columns


def test_both_column_spellings_parse_into_one_chronological_series():
    """`may_07_am` and `may26_am` are the same thing in two spellings."""
    outcome = transform.build([make_row()])
    surveys = outcome.patterns["sites"][properties_of(outcome)["id"]]["surveys"]
    assert [(s["year"], s["month"]) for s in surveys] == [
        (2007, 5),
        (2007, 9),
        (2018, 5),
        (2020, 10),
        (2024, 6),
        (2025, 5),
        (2026, 5),
    ]
    assert all(set(s) == {"year", "month", "label", "am", "md", "pm", "total", "complete"} for s in surveys)


def test_a_row_using_only_the_new_spelling_loses_nothing():
    """The no-underscore spelling must carry the same record as the other."""
    old = make_row("1")
    new = {
        key.replace("may_07_", "may07_")
        .replace("sept_07_", "sept07_")
        .replace("may_18_", "may18_"): value
        for key, value in old.items()
    }
    assert "may_07_am" not in new and "sept_07_am" not in new and "may_18_am" not in new
    assert "may07_am" in new and "sept07_am" in new and "may18_am" in new
    from_old = properties_of(transform.build([old]))
    from_new = properties_of(transform.build([new]))
    for field in ("am", "md", "pm", "total", "firstYear", "lastYear", "yearsMeasured", "latestSurvey"):
        assert from_old[field] == from_new[field], field
    assert from_old["id"] == from_new["id"]


def test_2019_absent_is_absence_not_zero():
    """A year with no columns does not appear, and does not become a zero year."""
    row = make_row()
    clear_survey(row, (2007, 9))
    clear_survey(row, (2018, 5))
    outcome = transform.build([row])
    properties = properties_of(outcome)
    assert properties["firstYear"] == 2007
    assert properties["lastYear"] == 2026
    # 2007, 2020, 2024, 2025, 2026. Never 2019, and never a zero for it.
    assert properties["yearsMeasured"] == 5
    years = {s["year"] for s in outcome.patterns["sites"][properties["id"]]["surveys"]}
    assert 2019 not in years
    assert 2018 not in years


def test_2020_is_october_only_and_2024_is_surveyed_in_june():
    outcome = transform.build([make_row()])
    surveys = outcome.patterns["sites"][properties_of(outcome)["id"]]["surveys"]
    by_key = {(s["year"], s["month"]): s for s in surveys}
    assert (2020, 10) in by_key and (2020, 5) not in by_key
    assert by_key[(2020, 10)]["label"] == "October 2020"
    assert by_key[(2024, 6)]["label"] == "June 2024"
    assert by_key[(2024, 6)]["am"] == 900


def test_the_p_m_spelling_is_the_same_period_as_pm_not_a_fourth_one():
    """`may_22_p_m` is the PM period. It canonicalises onto `pm`, so the value lands."""
    row = make_row()
    row["may_22_p_m"] = "9999"
    outcome = transform.build([row])
    assert outcome.pipeline["unhandledCountColumns"] == 0, outcome.pipeline["unhandledCountColumnNames"]
    assert "may_22_p_m" in outcome.pipeline["consumedCountColumnNames"]
    surveys = {(s["year"], s["month"]): s for s in outcome.patterns["sites"][properties_of(outcome)["id"]]["surveys"]}
    assert surveys[(2022, 5)]["pm"] == 9999
    # And it is the same field, not a fourth: exactly three periods exist.
    assert all(set(s) == {"year", "month", "label", "am", "md", "pm", "total", "complete"} for s in surveys.values())


def test_the_p_m_and_pm_spellings_of_one_survey_agree():
    """If a year ever ships BOTH spellings, they are the same measurement."""
    row = make_row()
    row["may_22_pm"] = "4242"
    row["may_22_p_m"] = "4242"
    outcome = transform.build([row])
    assert outcome.pipeline["unhandledCountColumns"] == 0
    surveys = {(s["year"], s["month"]): s for s in outcome.patterns["sites"][properties_of(outcome)["id"]]["surveys"]}
    assert (2022, 5) in surveys
    assert surveys[(2022, 5)]["pm"] == 4242
    assert surveys[(2022, 5)]["total"] == 4242


def test_a_hypothetical_fourth_spelling_is_drift_not_silence(tmp_path):
    """THE regression guard. A parser taught three spellings is not taught a fourth.

    `may_26_xm` is not a real column. It stands in for whatever the city does
    next, and the point is that the drift detector fires on a token it has
    never seen, without anybody adding a case for it.
    """
    row = make_row()
    row["may_26_xm"] = "7777"
    outcome = transform.build([row])
    assert outcome.pipeline["unhandledCountColumnNames"] == ["may_26_xm"]
    assert outcome.pipeline["unhandledCountColumns"] == 1
    assert "may_26_xm" not in outcome.pipeline["consumedCountColumnNames"]
    # Detected AND not consumed: the value is nowhere in the published series.
    surveys = outcome.patterns["sites"][properties_of(outcome)["id"]]["surveys"]
    assert all(s["pm"] != 7777 for s in surveys)

    result = check([row], tmp_path)
    assert any(
        "may_26_xm" in error and "SCHEMA DRIFT" in error for error in result.errors
    ), result.errors


def test_every_count_column_present_is_counted_as_consumed():
    """The equality that closes the argument, asserted directly on the live-shape row."""
    row = make_row()
    row["may_22_p_m"] = "9999"
    row["may_23_p_m"] = "8888"
    outcome = transform.build([row])
    present = transform.count_column_names([row])
    consumed = transform.parsed_column_names([row])
    assert present == consumed, sorted(present ^ consumed)
    assert outcome.pipeline["consumedCountColumns"] == len(consumed)
    assert outcome.pipeline["unhandledCountColumns"] == 0


def test_the_contract_consumes_all_three_live_spellings():
    """Pins the three spellings the live source uses, so one cannot be dropped quietly."""
    assert C.HISTORY_COLUMN_RE.match("may_07_am")
    assert C.HISTORY_COLUMN_RE.match("may26_am")
    assert C.HISTORY_COLUMN_RE.match("may_22_p_m")
    assert C.HISTORY_COLUMN_RE.match("may_23_p_m")
    # ...and that all four canonicalise onto the same three periods.
    periods = {
        column: C.history_columns({column: 1})[0]["period"]
        for column in ("may_07_am", "may26_am", "may_22_p_m", "oct20_md")
    }
    assert periods == {"may_07_am": "am", "may26_am": "am", "may_22_p_m": "pm", "oct20_md": "md"}


# --------------------------------------------------------------------------- periods


def test_nullish_count_string_is_null_and_a_genuine_zero_is_zero():
    row = make_row()
    row.update({"may26_am": "", "may26_md": "N/A", "may26_pm": "0"})
    properties = properties_of(transform.build([row]))
    assert properties["am"] is None
    assert properties["md"] is None
    assert properties["pm"] == 0
    assert properties["total"] == 0
    assert properties["latestSurvey"] == "May 2026"


def test_a_site_measured_in_the_morning_only_is_not_zero_everywhere_else():
    row = make_row("2")
    for key in SURVEY_PREFIXES:
        set_survey(row, key, md="", pm="")
    properties = properties_of(transform.build([row]))
    assert properties["am"] == 1100
    assert properties["md"] is None
    assert properties["pm"] is None
    # `total` is the sum of what WAS measured. A partial survey is not a day's
    # volume, which is why `change` refuses to use one — but publishing it as
    # null would hide a real morning observation.
    assert properties["total"] == 1100
    assert properties["total"] != 0


def test_total_is_always_the_sum_of_its_parts():
    for am, md, pm in ((1, 2, 3), (0, 0, 0), (7, None, None)):
        row = make_row()
        row.update({"may26_am": str(am), "may26_md": str(md) if md is not None else "", "may26_pm": str(pm)})
        properties = properties_of(transform.build([row]))
        parts = [properties[p] for p in C.HISTORY_PERIODS if properties[p] is not None]
        assert properties["total"] == sum(parts)


def test_a_survey_with_no_count_at_all_is_not_published_as_an_observation():
    row = make_row()
    set_survey(row, (2024, 6), am="", md="", pm="")
    outcome = transform.build([row])
    properties = properties_of(outcome)
    years = [s["year"] for s in outcome.patterns["sites"][properties["id"]]["surveys"]]
    assert 2024 not in years
    assert outcome.pipeline["surveysWithNoCounts"] == 1


# --------------------------------------------------------------------------- change


def test_change_is_populated_when_both_endpoints_are_complete_and_same_month():
    outcome = transform.build([make_row()])
    properties = properties_of(outcome)
    # first complete survey May 2007 = 630+1710+3262, last May 2026 = 1100+2600+4500
    assert properties["change"] == (1100 + 2600 + 4500) - (630 + 1710 + 3262)
    assert properties["changeYears"] == "May 2007 – May 2026"
    assert properties["trend"] == "rising"


def test_change_is_null_when_the_last_survey_is_not_a_complete_day():
    row = make_row()
    # May 2026 is measured in the morning only, and May 2025 is gone, so the
    # newest complete survey is the first one and there is no pair to compare.
    for key in ((2018, 5), (2020, 10), (2024, 6), (2025, 5)):
        clear_survey(row, key)
    set_survey(row, (2026, 5), md="", pm="")
    outcome = transform.build([row])
    properties = properties_of(outcome)
    assert properties["am"] == 1100 and properties["total"] == 1100
    assert properties["latestSurvey"] == "May 2026"
    assert properties["change"] is None
    assert properties["changeYears"] is None
    assert properties["trend"] == "insufficient"
    assert outcome.pipeline["changeInsufficientSingleSurvey"] == 1


def test_change_refuses_to_compare_different_months():
    """A May-to-October difference is mostly a statement about the season."""
    row = make_row()
    clear_survey(row, (2007, 5))
    clear_survey(row, (2026, 5))
    set_survey(row, (2007, 9), am="580", md="1600", pm="3100")
    row["oct_26_am"], row["oct_26_md"], row["oct_26_pm"] = "50", "500", "900"
    properties = properties_of(transform.build([row]))
    assert properties["change"] is None
    assert properties["trend"] == "insufficient"
    assert "changeInsufficientSingleSurvey" in transform.build([row]).pipeline


def test_change_refuses_a_span_shorter_than_the_minimum():
    row = make_row()
    for key in ((2007, 5), (2007, 9), (2018, 5), (2020, 10), (2024, 6), (2025, 5)):
        clear_survey(row, key)
    set_survey(row, (2024, 5), am="100", md="200", pm="300")
    set_survey(row, (2026, 5), am="1000", md="2000", pm="3000")
    outcome = transform.build([row])
    assert properties_of(outcome)["change"] is None
    assert outcome.pipeline["changeInsufficientShortSpan"] == 1


def test_a_site_with_no_complete_survey_has_no_comparison():
    row = make_row()
    for key in SURVEY_PREFIXES:
        set_survey(row, key, md="")
    outcome = transform.build([row])
    assert properties_of(outcome)["change"] is None
    assert properties_of(outcome)["trend"] == "insufficient"
    assert outcome.pipeline["changeInsufficientIncomplete"] == 1


# --------------------------------------------------------------------------- trend


@pytest.mark.parametrize(
    ("first_total", "last_total", "expected"),
    [
        (100, 200, "rising"),
        (200, 100, "falling"),
        (200, 210, "flat"),
        (200, 230, "flat"),
        (200, 240, "rising"),
    ],
)
def test_trend_buckets(first_total, last_total, expected):
    row = make_row()
    clear_survey(row, (2007, 9))
    clear_survey(row, (2018, 5))
    for period in ("am", "md", "pm"):
        row[f"may_07_{period}"] = str(first_total // 3)
        row[f"may_26_{period}"] = str(last_total // 3)
    # Correct for the integer division so the baseline is exactly `first_total`.
    row["may_07_md"] = str(first_total - 2 * (first_total // 3))
    row["may_26_md"] = str(last_total - 2 * (last_total // 3))
    assert properties_of(transform.build([row]))["trend"] == expected


def test_a_two_person_wobble_is_not_a_trend():
    row = make_row()
    clear_survey(row, (2007, 9))
    clear_survey(row, (2018, 5))
    for period in ("am", "md", "pm"):
        row[f"may_07_{period}"] = "1000"
        row[f"may_26_{period}"] = "1000"
    row["may_26_pm"] = "1002"
    properties = properties_of(transform.build([row]))
    assert properties["change"] == 2
    assert properties["trend"] == "flat"


# --------------------------------------------------------------------------- identity


def test_name_is_street_at_cross_street_verbatim():
    """No abbreviation expansion: the source has no canonical form to expand to."""
    row = make_row(street_nam="Gra Concourse", from_stree="East 164th Street")
    assert properties_of(transform.build([row]))["name"] == "Gra Concourse at East 164th Street"


def test_name_is_just_the_street_when_there_is_no_cross_street():
    row = make_row()
    row["street_nam"] = "Brooklyn Bridge"
    row["from_stree"] = ""
    row["to_street"] = ""
    properties = properties_of(transform.build([row]))
    assert properties["crossStreet"] is None
    assert properties["name"] == "Brooklyn Bridge"
    assert properties["id"] == C.history_id("1", "Brooklyn Bridge", "")


def test_cross_street_falls_back_to_to_street():
    row = make_row()
    row["from_stree"] = ""
    assert properties_of(transform.build([row]))["crossStreet"] == "Naples Terrace"


def test_midpoint_is_published_as_dots_written_not_guessed_at():
    row = make_row()
    row["street_nam"] = "Williamsburg Bridge"
    row["from_stree"] = "midpoint"
    row["to_street"] = ""
    outcome = transform.build([row])
    assert properties_of(outcome)["name"] == "Williamsburg Bridge at midpoint"
    assert outcome.pipeline["midpointCrossStreet"] == 1


def test_id_comes_from_the_shared_recipe_and_iex_becomes_a_boolean():
    properties = properties_of(transform.build([make_row(iex="Y")]))
    assert properties["id"] == C.history_id("1", "Broadway", "West 231st Street")
    assert C.HISTORY_ID_RE.match(properties["id"])
    assert properties["inPedestrianVolumeIndex"] is True
    assert properties_of(transform.build([make_row(iex="N")]))["inPedestrianVolumeIndex"] is False


def test_property_order_is_the_frozen_contract():
    properties = properties_of(transform.build([make_row()]))
    assert tuple(properties) == C.HISTORY_PROPERTY_ORDER


# --------------------------------------------------------------------------- rejections


def test_a_row_with_no_geometry_is_rejected_with_a_reason():
    row = make_row("7", the_geom=None)
    outcome = transform.build([row])
    assert outcome.features == []
    assert reasons(outcome) == ["missing_geometry"]
    assert outcome.report["history"]["rejected"]["missing_geometry"] == 1
    assert "no point to put on the map" in outcome.report["history"]["rejections"][0]["reason"]
    assert outcome.report["history"]["publishedLocations"] == 0


def test_a_row_outside_the_bounding_box_is_rejected_with_a_reason():
    row = make_row("8", the_geom={"type": "Point", "coordinates": [-71.0, 42.0]})
    outcome = transform.build([row])
    assert reasons(outcome) == ["out_of_bounds"]
    assert "outside the NYC bounding box" in outcome.report["history"]["rejections"][0]["reason"]


def test_a_non_point_geometry_is_rejected_rather_than_guessed_at():
    row = make_row("9", the_geom={"type": "LineString", "coordinates": [[-73.9, 40.8], [-73.8, 40.9]]})
    assert reasons(transform.build([row])) == ["unsupported_geometry"]


def test_a_non_numeric_coordinate_is_rejected():
    row = make_row("10", the_geom={"type": "Point", "coordinates": ["nope", 40.8]})
    assert reasons(transform.build([row])) == ["unparseable_coordinates"]


def test_a_row_with_no_identity_is_rejected():
    row = make_row("11")
    row["loc"] = ""
    assert reasons(transform.build([row])) == ["missing_identity"]


def test_borough_values_outside_the_five_boroughs_are_published_and_counted():
    """`borough` is a location descriptor that sometimes names a waterway.

    Rejecting it would drop 19 real count sites; mapping it would need a
    bridge-to-borough table the city never published. So it is published
    verbatim, counted, and warned about.
    """
    row = make_row("12", borough="Harlem River Bridges")
    outcome = transform.build([row])
    assert properties_of(outcome)["borough"] == "Harlem River Bridges"
    assert outcome.pipeline["nonBoroughBoroughValues"] == 1
    assert "Harlem River Bridges" not in C.BOROUGHS


def test_the_report_counts_distinct_borough_values_so_drift_is_visible():
    """A counts dict alone does not say whether the vocabulary grew or shrank."""
    rows = [
        make_row("1", borough="Brooklyn"),
        make_row("2", borough="Brooklyn"),
        make_row("3", borough="Harlem River Bridges"),
    ]
    report = transform.build(rows).report["history"]
    assert report["boroughs"] == {"Brooklyn": 2, "Harlem River Bridges": 1}
    assert report["boroughValueCount"] == 2
    assert sum(report["boroughs"].values()) == 3


def test_a_corrected_borough_value_needs_no_code_change_to_publish():
    """The test that matters for (b): nothing keys on a known-odd literal.

    If the city fixes "Staten Isla" to "Staten Island", the sites must publish
    cleanly and the count must simply move from the not-a-borough tally to the
    borough tally — with no edit to the pipeline.
    """
    corrected = check([make_row("1", borough="Staten Island")], Path(_tmp_dir()))
    assert corrected.errors == []
    assert not any("borough" in warning for warning in corrected.warnings)
    assert corrected.stats["boroughs"] == {"Staten Island": 1}
    assert corrected.stats["boroughValuesNotABorough"] == 0

    # And the truncated form is still published verbatim, not repaired.
    truncated = check([make_row("1", borough="Staten Isla")], Path(_tmp_dir()))
    assert truncated.errors == []
    assert truncated.stats["boroughs"] == {"Staten Isla": 1}
    assert truncated.stats["boroughValueCount"] == 1
    assert truncated.stats["boroughValuesNotABorough"] == 1
    assert any("'Staten Isla'" in warning for warning in truncated.warnings)


def test_no_source_module_keys_on_the_truncated_borough_literal():
    """Guards the policy against a future "helpful" special case.

    If any of these modules ever lists "Staten Isla" in code, a correction by
    the city would break the build — the opposite of what this design wants.
    """
    for module in (transform, validate):
        source = Path(module.__file__).read_text(encoding="utf-8")
        # Strip comment lines: naming the value in prose is exactly what we want.
        code = "\n".join(
            line for line in source.splitlines() if not line.lstrip().startswith("#")
        )
        assert '"Staten Isla"' not in code, f"{module.__name__} compares a borough literal"
        assert "'Staten Isla'" not in code, f"{module.__name__} compares a borough literal"
        assert "Staten Isla" not in code, f"{module.__name__} keys on a borough literal"


def test_two_rows_that_collide_on_one_id_stop_the_build():
    """Silently overwriting the loser would drop a site with no trace."""
    rows = [make_row("1"), make_row("1", objectid="2")]
    with pytest.raises(C.DataError) as raised:
        transform.build(rows)
    assert "collides with an earlier row" in str(raised.value)


# --------------------------------------------------------------------------- determinism


def test_row_order_does_not_change_a_single_byte(tmp_path):
    rows = [make_row("1"), make_row("2", street_nam="Fifth Avenue"), make_row("3", borough="Queens")]
    reordered = list(reversed(rows))

    def build_and_write(order, name):
        outcome = transform.build(
            order, generated_at="2026-09-28T00:00:00Z", retrieved_at="2026-09-28T00:00:00Z"
        )
        return write_all(outcome, tmp_path / name)

    first = build_and_write(rows, "a")
    second = build_and_write(reordered, "b")
    for key in ("geojson", "patterns", "report"):
        assert first[key].read_bytes() == second[key].read_bytes(), key


def test_content_hash_ignores_row_order():
    rows = [make_row("1"), make_row("2", street_nam="Fifth Avenue")]
    assert (
        transform.build(rows).content_hash == transform.build(list(reversed(rows))).content_hash
    )
    assert transform.build(rows).content_hash == C.content_hash(transform.build(rows).features)


def test_content_hash_ignores_the_generation_timestamp():
    rows = [make_row("1")]
    first = transform.build(rows, generated_at="2026-01-01T00:00:00Z")
    second = transform.build(rows, generated_at="2026-09-28T00:00:00Z")
    assert first.content_hash == second.content_hash
    assert first.report["history"]["generatedAt"] != second.report["history"]["generatedAt"]


# --------------------------------------------------------------------------- the artifacts


def test_the_survey_series_is_marked_discrete_so_no_line_can_be_invented(tmp_path):
    result = check([make_row()], tmp_path)
    assert not result.errors
    document = json.loads((tmp_path / "historical-patterns.json").read_text())
    assert document["measurement"] == "discrete screenline survey"
    assert document["interpolation"] == "none"
    entry = next(iter(document["sites"].values()))
    assert entry["discrete"] is True
    assert entry["interpolate"] is False


def test_a_clean_build_validates(tmp_path):
    result = check(
        [make_row("1"), make_row("2", street_nam="Fifth Avenue"), make_row("3", borough="Queens")],
        tmp_path,
    )
    assert result.errors == []
    assert result.stats["uniqueIds"] == 3
    assert result.stats["locationCount"] == 3


# --------------------------------------------------------------------------- the validator


def test_validator_rejects_an_id_that_is_not_a_history_id(tmp_path):
    outcome = transform.build([make_row()])
    outcome.features[0]["properties"]["id"] = "wsh-NOTHEX"
    outcome.features[0]["id"] = "wsh-NOTHEX"
    paths = write_all(outcome, tmp_path)
    C.write_json_file(paths["raw"], [make_row()])
    result = validate.validate(
        geojson_path=paths["geojson"],
        patterns_path=paths["patterns"],
        report_path=paths["report"],
        raw_path=paths["raw"],
        min_locations=0,
    )
    assert any("does not match" in error for error in result.errors)


def test_validator_rejects_a_duplicate_id(tmp_path):
    outcome = transform.build([make_row()])
    outcome.features.append(copy.deepcopy(outcome.features[0]))
    paths = write_all(outcome, tmp_path)
    C.write_json_file(paths["raw"], [make_row()])
    result = validate.validate(
        geojson_path=paths["geojson"],
        patterns_path=paths["patterns"],
        report_path=paths["report"],
        raw_path=paths["raw"],
        min_locations=0,
    )
    assert any("duplicate id" in error for error in result.errors)


def test_validator_rejects_a_wrong_property_type(tmp_path):
    outcome = transform.build([make_row()])
    outcome.features[0]["properties"]["am"] = "1100"  # a string, where the contract says integer|null
    paths = write_all(outcome, tmp_path)
    C.write_json_file(paths["raw"], [make_row()])
    result = validate.validate(
        geojson_path=paths["geojson"],
        patterns_path=paths["patterns"],
        report_path=paths["report"],
        raw_path=paths["raw"],
        min_locations=0,
    )
    assert any(
        ".am is string" in error and "expected one of ['integer', 'null']" in error
        for error in result.errors
    )


def test_validator_rejects_a_total_that_disagrees_with_its_parts(tmp_path):
    outcome = transform.build([make_row()])
    outcome.features[0]["properties"]["total"] = 999_999
    paths = write_all(outcome, tmp_path)
    C.write_json_file(paths["raw"], [make_row()])
    result = validate.validate(
        geojson_path=paths["geojson"],
        patterns_path=paths["patterns"],
        report_path=paths["report"],
        raw_path=paths["raw"],
        min_locations=0,
    )
    assert any(".total is 999999" in error for error in result.errors)


def test_validator_rejects_a_trend_the_contract_does_not_define(tmp_path):
    outcome = transform.build([make_row()])
    outcome.features[0]["properties"]["trend"] = "surging"
    paths = write_all(outcome, tmp_path)
    C.write_json_file(paths["raw"], [make_row()])
    result = validate.validate(
        geojson_path=paths["geojson"],
        patterns_path=paths["patterns"],
        report_path=paths["report"],
        raw_path=paths["raw"],
        min_locations=0,
    )
    assert any("expected one of ['rising', 'falling', 'flat', 'insufficient']" in e for e in result.errors)


def test_validator_rejects_a_trend_with_no_comparable_pair(tmp_path):
    """A trend that disagrees with a null `change` is a claim nothing supports."""
    outcome = transform.build([make_row()])
    outcome.features[0]["properties"]["change"] = None
    outcome.features[0]["properties"]["changeYears"] = None
    paths = write_all(outcome, tmp_path)
    C.write_json_file(paths["raw"], [make_row()])
    result = validate.validate(
        geojson_path=paths["geojson"],
        patterns_path=paths["patterns"],
        report_path=paths["report"],
        raw_path=paths["raw"],
        min_locations=0,
    )
    assert any("trend is 'rising' but change is null" in error for error in result.errors)


def test_validator_fails_on_a_count_column_spelling_the_transform_never_read(tmp_path):
    """THE drift check. A new spelling silently loses its data unless this fails."""
    rows = [make_row()]
    # Build from a row WITHOUT the mystery column, so the transform's record of
    # what it consumed genuinely predates the column's arrival.
    outcome = transform.build(rows)
    paths = write_all(outcome, tmp_path)
    arrived = [make_row()]
    arrived[0]["may_22_night"] = "1234"
    C.write_json_file(paths["raw"], arrived)

    result = validate.validate(
        geojson_path=paths["geojson"],
        patterns_path=paths["patterns"],
        report_path=paths["report"],
        raw_path=paths["raw"],
        min_locations=0,
    )
    assert any(
        "may_22_night" in error and "SCHEMA DRIFT" in error and "NOT" in error
        for error in result.errors
    ), result.errors


def test_validator_fails_on_a_negative_or_non_numeric_count_cell(tmp_path):
    rows = [make_row()]
    outcome = transform.build(rows)
    paths = write_all(outcome, tmp_path)
    corrupted = [make_row()]
    corrupted[0]["may_18_am"] = "-3"
    C.write_json_file(paths["raw"], corrupted)

    result = validate.validate(
        geojson_path=paths["geojson"],
        patterns_path=paths["patterns"],
        report_path=paths["report"],
        raw_path=paths["raw"],
        min_locations=0,
    )
    assert any("not non-negative integers" in error and "may_18_am='-3'" in error for error in result.errors)


def test_validator_fails_when_the_geometry_column_disappears(tmp_path):
    outcome = transform.build([make_row()])
    paths = write_all(outcome, tmp_path)
    C.write_json_file(paths["raw"], [{k: v for k, v in make_row().items() if k != "the_geom"}])
    result = validate.validate(
        geojson_path=paths["geojson"],
        patterns_path=paths["patterns"],
        report_path=paths["report"],
        raw_path=paths["raw"],
        min_locations=0,
    )
    assert any("no the_geom" in error for error in result.errors)


def test_validator_warns_but_does_not_fail_on_a_borough_that_is_not_a_borough(tmp_path):
    """A value the pipeline can pass through verbatim is a warning, not an error."""
    result = check([make_row("1", borough="Harlem River Bridges")], tmp_path)
    assert result.errors == []
    assert any("Harlem River Bridges" in warning for warning in result.warnings)
    # A known bridge group: warned about, but not drift.
    assert not any("SCHEMA DRIFT" in warning for warning in result.warnings)
    assert result.stats["boroughValuesNotABorough"] == 0

    # A value that is neither a borough nor a known bridge group — a truncation,
    # or a descriptor nobody has seen. Drift to report, still published.
    result = check([make_row("1", borough="Staten Isla")], tmp_path)
    assert result.errors == []
    assert any("'Staten Isla'" in warning and "SCHEMA DRIFT" in warning for warning in result.warnings)
    assert result.stats["boroughValuesNotABorough"] == 1


def test_validator_fails_on_an_unexpected_iex_value(tmp_path):
    """Unlike borough, a third `iex` value WOULD make the boolean a guess."""
    result = check([make_row("1", iex="MAYBE")], tmp_path)
    assert any("iex value 'MAYBE'" in error for error in result.errors)


def test_validator_fails_on_a_missing_artifact(tmp_path):
    result = validate.validate(
        geojson_path=tmp_path / "nope.geojson",
        patterns_path=tmp_path / "nope.json",
        report_path=tmp_path / "nope-report.json",
        raw_path=tmp_path / "nope-raw.json",
        min_locations=0,
    )
    assert len(result.errors) == 4
    assert all("missing" in error for error in result.errors)


def test_validator_fails_when_the_artifact_outgrows_its_budget(tmp_path):
    result = check([make_row()], tmp_path)
    assert not result.errors
    # A tiny budget stands in for a real runaway; the check is the point.
    original = validate.MAX_PATTERNS_BYTES
    validate.MAX_PATTERNS_BYTES = 10
    try:
        result = validate.validate(
            geojson_path=tmp_path / "historical-locations.geojson",
            patterns_path=tmp_path / "historical-patterns.json",
            report_path=tmp_path / "report.json",
            raw_path=tmp_path / "raw.json",
            min_locations=0,
        )
    finally:
        validate.MAX_PATTERNS_BYTES = original
    assert any("over the 10-byte budget" in error for error in result.errors)


def test_validator_fails_on_a_record_count_collapse(tmp_path):
    result = check([make_row()], tmp_path, min_locations=100)
    assert any("record count collapse" in error for error in result.errors)


def test_validator_fails_when_the_report_claims_columns_the_source_lacks(tmp_path):
    outcome = transform.build([make_row()])
    half = outcome.report["history"]["pipeline"]
    half["consumedCountColumnNames"] = sorted(
        list(half["consumedCountColumnNames"]) + ["sept_99_am"]
    )
    paths = write_all(outcome, tmp_path)
    C.write_json_file(paths["raw"], [make_row()])
    result = validate.validate(
        geojson_path=paths["geojson"],
        patterns_path=paths["patterns"],
        report_path=paths["report"],
        raw_path=paths["raw"],
        min_locations=0,
    )
    assert any("sept_99_am" in error and "no longer has" in error for error in result.errors)


def test_validator_fails_when_the_report_loses_its_top_level_key(tmp_path):
    """A half-report at the top level would silently drop the sensor half on merge."""
    outcome = transform.build([make_row()])
    bare = outcome.report["history"]
    paths = write_all(outcome, tmp_path)
    C.write_json_file(paths["raw"], [make_row()])
    C.write_json_file(paths["report"], bare)
    result = validate.validate(
        geojson_path=paths["geojson"],
        patterns_path=paths["patterns"],
        report_path=paths["report"],
        raw_path=paths["raw"],
        min_locations=0,
    )
    assert any("top-level 'history' key" in error for error in result.errors), result.errors


def test_the_report_merges_with_the_sensor_half_without_a_shared_key():
    """The namespacing is the merge mechanism, so assert the merge is trivial."""
    outcome = transform.build([make_row()])
    assert list(outcome.report) == ["history"], "this half must write exactly one top-level key"
    # No top-level key the sensor half also uses. `sensors` is theirs.
    assert "sensors" not in outcome.report
    merged = {**{"sensors": {"contentHash": "x"}}, **outcome.report}
    assert set(merged) == {"sensors", "history"}
    assert merged["sensors"]["contentHash"] == "x"


def test_validator_fails_when_the_content_hash_does_not_match_the_features(tmp_path):
    outcome = transform.build([make_row()])
    outcome.report["history"]["contentHash"] = "0" * 64
    paths = write_all(outcome, tmp_path)
    C.write_json_file(paths["raw"], [make_row()])
    result = validate.validate(
        geojson_path=paths["geojson"],
        patterns_path=paths["patterns"],
        report_path=paths["report"],
        raw_path=paths["raw"],
        min_locations=0,
    )
    assert any("report.history.contentHash" in error for error in result.errors)
