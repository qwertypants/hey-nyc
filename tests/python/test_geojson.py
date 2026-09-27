"""The published artifacts: property set, types, metadata.json and report.json."""

from __future__ import annotations

import json

from conftest import make_pair, make_row

import _common as C
import clean_data


def test_property_set_is_exactly_the_contract(build):
    properties = clean_data.build_artifacts([make_row()]).features[0]["properties"]
    assert set(properties) == set(C.PROPERTY_ORDER)
    assert len(properties) == 14


def test_every_property_has_the_javascript_type_the_interface_declares(build):
    import validate_data

    features = clean_data.build_artifacts([make_row()]).features
    for name, allowed in C.PROPERTY_TYPES.items():
        kind = validate_data.js_kind(features[0]["properties"][name])
        assert kind in allowed, f"{name} is {kind}, expected one of {allowed}"


def test_nullable_properties_can_be_null(build):
    features = clean_data.build_artifacts(
        [make_row(city=None, nta2020=None, bbl="1", license_issue_date=None)]
    ).features
    properties = features[0]["properties"]
    assert properties["neighborhood"] is None
    assert properties["nta"] is None
    assert properties["bbl"] is None
    assert properties["licenseIssued"] is None


def test_non_nullable_properties_are_always_strings(build):
    rows = make_pair()
    for row in rows:
        row["postcode"] = None
        row["license_status"] = None
    properties = clean_data.build_artifacts(rows).features[0]["properties"]
    assert properties["zip"] == ""
    assert properties["status"] == ""
    assert isinstance(properties["name"], str)
    assert isinstance(properties["legalName"], str)
    assert isinstance(properties["street"], str)
    assert isinstance(properties["borough"], str)


def test_feature_id_mirrors_the_property_id(build):
    feature = clean_data.build_artifacts([make_row()]).features[0]
    assert feature["id"] == feature["properties"]["id"]


def test_sid_is_a_sorted_array_of_source_row_ids(build):
    properties = clean_data.build_artifacts(make_pair()).features[0]["properties"]
    assert properties["sid"] == sorted(properties["sid"])
    assert all(isinstance(s, str) for s in properties["sid"])


def test_metadata_has_every_dataset_metadata_field(build):
    metadata = clean_data.build_artifacts([make_row()]).metadata
    assert metadata["dataset"] == "Dining Out NYC Locations"
    assert metadata["datasetId"] == "fpeh-f7ci"
    assert metadata["provider"] == "New York City Department of Transportation"
    assert metadata["attribution"] == "Department of Transportation (DOT)"
    assert metadata["source"].startswith("https://data.cityofnewyork.us/")
    assert metadata["recordCount"] == 1
    assert metadata["sourceRowCount"] == 1
    assert metadata["counts"] == {"sidewalk": 1, "roadway": 0, "both": 0}
    assert metadata["boroughs"] == {"Brooklyn": 1}
    assert len(metadata["contentHash"]) == 64


def test_metadata_timestamps_are_utc_iso_with_a_z(build):
    metadata = clean_data.build_artifacts(
        [make_row()], retrieved_at="2026-09-27T12:00:00Z", source_updated_at="2026-09-27T11:30:49Z"
    ).metadata
    assert metadata["retrievedAt"] == "2026-09-27T12:00:00Z"
    assert metadata["sourceUpdatedAt"] == "2026-09-27T11:30:49Z"


def test_generated_at_defaults_to_now_in_utc(build):
    import re

    metadata = clean_data.build_artifacts([make_row()]).metadata
    assert re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z", metadata["retrievedAt"])


def test_epoch_rows_updated_at_is_converted():
    assert C.epoch_to_iso(1790512249) == "2026-09-27T12:30:49Z"
    assert C.epoch_to_iso(None) is None
    assert C.epoch_to_iso("nope") is None


def test_report_has_every_data_report_field(build):
    report = clean_data.build_artifacts(make_pair()).report
    for key in (
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
    ):
        assert key in report
    assert report["rejected"] == {
        "outOfBounds": 0,
        "unknownBorough": 0,
        "unparseableCoordinates": 0,
        "missingCoordinates": 0,
    }
    assert report["sourceRows"] == 2
    assert report["publishedLocations"] == 1
    assert report["both"] == 1


def test_report_rejection_entries_have_the_frozen_shape(build):
    outcome = build([make_row(borough=None)])
    entry = outcome.report["rejections"][0]
    assert set(entry) == {
        "name",
        "street",
        "city",
        "borough",
        "latitude",
        "longitude",
        "reason",
    }
    assert entry["borough"] is None
    assert entry["latitude"] == 40.683381422171
    assert isinstance(entry["reason"], str) and entry["reason"]


def test_report_rejections_are_ordered_deterministically(build):
    rows = [
        make_row(sid="row-1", business_legal_name="Z LLC", borough=None),
        make_row(sid="row-2", business_legal_name="A LLC", borough=None),
        make_row(sid="row-3", latitude="42.1", longitude="-70.8"),
    ]
    first = build(rows).report["rejections"]
    second = build(list(reversed(rows))).report["rejections"]
    assert first == second
    assert [r["reason"].split(":")[0] for r in first] == [
        "out_of_bounds",
        "unknown_borough",
        "unknown_borough",
    ]


def test_written_geojson_is_a_feature_collection(published):
    published(make_pair())
    payload = json.loads(published.paths["GEOJSON_PATH"].read_text(encoding="utf-8"))
    assert payload["type"] == "FeatureCollection"
    assert len(payload["features"]) == 1
    assert payload["features"][0]["geometry"]["type"] == "Point"
    assert len(payload["features"][0]["geometry"]["coordinates"]) == 2
