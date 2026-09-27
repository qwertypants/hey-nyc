"""inspect_data.py: an exploration tool that must never crash on real data."""

from __future__ import annotations

import json

import pytest
from conftest import make_pair, make_row

import inspect_data
from conftest import BASE_ROW


def test_row_count_and_column_profile():
    report = inspect_data.build_report([make_row()])
    assert report["rowCount"] == 1
    assert "errors" not in report
    columns = {c["column"]: c for c in report["columns"]}
    assert columns["business_legal_name"]["present"] == 1
    assert columns["bbl"]["null"] == 0
    report = inspect_data.build_report([make_row(bbl=None)])
    columns = {c["column"]: c for c in report["columns"]}
    assert columns["bbl"]["null"] == 1
    assert columns["bbl"]["distinct"] == 1  # the single distinct value is null


def test_categorical_counts_for_the_documented_columns():
    rows = make_pair() + [make_row(sid="row-c", license_type="Roadway", city="ASTORIA")]
    report = inspect_data.build_report(rows)
    categorical = report["categorical"]
    assert {v["value"]: v["count"] for v in categorical["license_type"]} == {
        "Sidewalk": 1,
        "Roadway": 2,
    }
    assert {v["value"]: v["count"] for v in categorical["borough"]} == {"Brooklyn": 3}
    assert {v["value"]: v["count"] for v in categorical["city"]}["BROOKLYN"] == 2
    assert {v["value"]: v["count"] for v in categorical["license_status"]} == {"Issued": 3}


def test_null_categoricals_are_shown_as_a_value():
    report = inspect_data.build_report([make_row(borough=None)])
    borough = report["categorical"]["borough"][0]
    assert borough["value"] == "<null>" and borough["count"] == 1


def test_coordinate_profile_lists_the_outliers():
    rows = [
        make_row(sid="row-ok"),
        make_row(sid="row-boston", latitude="42.1264412", longitude="-70.8480884"),
    ]
    coords = inspect_data.build_report(rows)["coordinates"]
    assert coords["inBounds"] == 1
    assert len(coords["outOfBounds"]) == 1
    assert coords["outOfBounds"][0]["legalName"] == "EMH 919 INC"
    assert coords["latMax"] == 42.1264412
    assert coords["bbox"] == {"lat": [40.40, 41.00], "lng": [-74.30, -73.65]}


def test_postcode_anomalies_and_leading_zeros():
    report = inspect_data.build_report([make_row(postcode="07307"), make_row(sid="row-2", postcode="1123")])
    postcode = report["postcode"]
    assert postcode["leadingZeroValues"] == ["07307"]
    assert postcode["anomalies"] == ["1123"]
    assert postcode["lengthHistogram"] == {"5": 1, "4": 1}


def test_degenerate_bbl_is_called_out():
    rows = [make_row(bbl="1"), make_row(sid="row-2", bbl="3"), make_row(sid="row-3", bbl="18830048")]
    bbl = inspect_data.build_report(rows)["bbl"]
    assert bbl["degenerateTotal"] == 2
    assert [d["value"] for d in bbl["degenerate"]] == ["1", "3"]
    assert bbl["shortButPlausible"][0]["bbl"] == "18830048"


def test_group_size_distribution_and_both_pairs():
    rows = make_pair() + [make_row(sid="row-c", business_legal_name="LONE LLC")]
    groups = inspect_data.build_report(rows)["groups"]
    assert groups["groups"] == 2
    assert groups["sizeHistogram"] == {"1": 1, "2": 1}
    assert groups["sidewalkAndRoadwayPairs"] == 1
    assert groups["sameTypePairs"] == 0
    assert groups["threePlusGroups"] == 0
    assert groups["coordinateDisagreements"] == 0
    assert groups["groupsWithIdenticalCoordinates"] == 1


def test_rejection_profile_matches_what_clean_data_would_do():
    rows = [
        make_row(sid="row-ok"),
        make_row(sid="row-jersey", borough=None, city="JERSEY CITY", postcode="07307"),
        make_row(sid="row-boston", latitude="42.1264412", longitude="-70.8480884"),
    ]
    rejections = inspect_data.build_report(rows)["rejections"]
    assert rejections["total"] == 2
    assert rejections["keptRows"] == 1
    assert rejections["byReason"] == {"unknown_borough": 1, "out_of_bounds": 1}
    assert rejections["samples"]["unknown_borough"][0]["city"] == "JERSEY CITY"


def test_samples_are_included():
    report = inspect_data.build_report([make_row(), make_row(sid="row-2")], samples=2)
    assert len(report["samples"]) == 2
    assert report["samples"][0][":id"] == "row-aaaa.bbbb.cccc"


@pytest.mark.parametrize(
    "rows",
    [
        [],
        [{}],
        [make_row(latitude="nope")],
        [make_row(street=None, business_legal_name=None)],
        [make_row(borough="Atlantis", city="", postcode=None, nta2020="")],
        [{"totally": "different"}],
    ],
    ids=["empty", "empty-row", "bad-coords", "no-identity", "odd-values", "unknown-schema"],
)
def test_it_never_crashes(rows):
    report = inspect_data.build_report(rows, samples=1)
    assert report["rowCount"] == len(rows)
    assert inspect_data.format_report(report)
    assert inspect_data.format_summary(report)
    json.dumps(report)  # --json must serialise


def test_a_broken_section_is_reported_not_raised(monkeypatch):
    def explode(rows):
        raise RuntimeError("boom")

    monkeypatch.setattr(inspect_data, "bbl_profile", explode)
    report = inspect_data.build_report([make_row()])
    assert "bbl" in report["errors"]
    assert "SECTION ERRORS" in inspect_data.format_report(report)
    assert report["columns"] is not None


def test_summary_is_short_and_says_where_the_full_dump_is():
    text = inspect_data.format_summary(inspect_data.build_report([make_row()]))
    assert "rows 1" in text
    assert len(text.splitlines()) < 20


def test_expected_numbers_are_published_for_comparison():
    expected = inspect_data.build_report([make_row()])["expected"]
    assert expected["rowCount"] == 2437
    assert expected["publishedLocations"] == 2000
    assert expected["types"] == {"sidewalk": 1173, "roadway": 396, "both": 431}


def test_main_prints_json(isolated_paths, capsys):
    isolated_paths["RAW_DATA_PATH"].write_text(json.dumps([make_row()]))
    assert inspect_data.main(["--json", "--raw", str(isolated_paths["RAW_DATA_PATH"])]) == 0
    payload = json.loads(capsys.readouterr().out)
    assert payload["rowCount"] == 1
    assert payload["datasetId"] == "fpeh-f7ci"


def test_main_reports_a_missing_snapshot(isolated_paths, capsys):
    code = inspect_data.main(["--raw", str(isolated_paths["RAW_DATA_PATH"])])
    assert code == 1
    assert "missing file" in capsys.readouterr().err


def test_main_rejects_bad_arguments():
    with pytest.raises(SystemExit):
        inspect_data.main(["--nope"])


def test_the_fixture_matches_the_documented_column_set():
    assert ":id" in BASE_ROW
    assert BASE_ROW["nta2020"] == "BK0204"
    assert len(BASE_ROW["nta2020"]) == 6
