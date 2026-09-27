"""validate_data.py: corruption is fatal, schema drift is a loud warning."""

from __future__ import annotations

import json

from conftest import make_pair, make_row

import validate_data


def result_for(published):
    return validate_data.validate(min_records=0)


def errors(result) -> str:
    return "\n".join(result.errors)


def warnings(result) -> str:
    return "\n".join(result.warnings)


#: These fixtures hold a handful of rows, so the comparison against the
#: 2026-09-27 measurement always fires. That is correct behaviour; the tests
#: below only care about drift they did not deliberately introduce.
SCALE_DRIFT = (
    "SCHEMA DRIFT: report.sourceRows",
    "SCHEMA DRIFT: report.publishedLocations",
    "SCHEMA DRIFT: report.sidewalk",
    "SCHEMA DRIFT: report.roadway",
    "SCHEMA DRIFT: report.both",
    "SCHEMA DRIFT: report.rejected.",
)


def unexpected_warnings(result) -> list[str]:
    return [w for w in result.warnings if not w.startswith(SCALE_DRIFT)]


# --------------------------------------------------------------------------- happy path


def test_a_clean_artifact_set_validates(published):
    published(make_pair() + [make_row(sid="row-c", business_legal_name="OTHER LLC")])
    result = result_for(published)
    assert result.errors == []
    assert unexpected_warnings(result) == []
    assert result.stats["recordCount"] == 2
    assert result.stats["uniqueIds"] == 2
    assert result.stats["uniqueSourceRows"] == 3
    assert result.stats["counts"] == {"sidewalk": 1, "roadway": 0, "both": 1}


def test_schema_constant_records_the_measured_expectations():
    assert validate_data.SCHEMA["datasetId"] == "fpeh-f7ci"
    assert validate_data.SCHEMA["sourceRows"] == 2437
    assert validate_data.SCHEMA["publishedLocations"] == 2000
    assert validate_data.SCHEMA["rejected"] == {
        "outOfBounds": 2,
        "unknownBorough": 4,
        "unparseableCoordinates": 0,
        "missingCoordinates": 0,
    }
    assert validate_data.SCHEMA["types"] == {"sidewalk": 1173, "roadway": 396, "both": 431}
    assert validate_data.SCHEMA["licenseStatuses"] == {"Issued"}
    assert validate_data.SCHEMA["sourceLicenseTypes"] == {"Sidewalk", "Roadway"}
    assert validate_data.SCHEMA["boroughs"] == {
        "Manhattan",
        "Brooklyn",
        "Queens",
        "Bronx",
        "Staten Island",
    }
    assert validate_data.SCHEMA["diningTypes"] == {"sidewalk", "roadway", "both"}
    assert validate_data.SCHEMA["idPattern"] == r"^eoy\-[0-9a-f]{12}$"


# --------------------------------------------------------------------------- corruption


def test_duplicate_ids_are_fatal(published):
    published([make_row(sid="row-1")])
    payload = json.loads(published.paths["GEOJSON_PATH"].read_text())
    clone = json.loads(json.dumps(payload["features"][0]))
    payload["features"].append(clone)
    published.paths["GEOJSON_PATH"].write_text(json.dumps(payload))
    assert "duplicate id" in errors(result_for(published))


def test_a_malformed_id_is_fatal(published):
    published([make_row()])
    payload = json.loads(published.paths["GEOJSON_PATH"].read_text())
    payload["features"][0]["properties"]["id"] = "not-an-eoy-id"
    published.paths["GEOJSON_PATH"].write_text(json.dumps(payload))
    assert "does not match" in errors(result_for(published))


def test_out_of_bounds_coordinates_are_fatal(published):
    published([make_row()])
    payload = json.loads(published.paths["GEOJSON_PATH"].read_text())
    payload["features"][0]["geometry"]["coordinates"] = [-70.8480884, 42.1264412]
    published.paths["GEOJSON_PATH"].write_text(json.dumps(payload))
    assert "outside the NYC bounding box" in errors(result_for(published))


def test_a_non_finite_coordinate_is_fatal(published):
    published([make_row()])
    payload = json.loads(published.paths["GEOJSON_PATH"].read_text())
    payload["features"][0]["geometry"]["coordinates"] = [float("nan"), 40.7]
    published.paths["GEOJSON_PATH"].write_text(json.dumps(payload))
    assert "two finite numbers" in errors(result_for(published))


def test_a_non_point_geometry_is_fatal(published):
    published([make_row()])
    payload = json.loads(published.paths["GEOJSON_PATH"].read_text())
    payload["features"][0]["geometry"]["type"] = "Polygon"
    published.paths["GEOJSON_PATH"].write_text(json.dumps(payload))
    assert "must be a Point" in errors(result_for(published))


def test_a_missing_property_is_fatal(published):
    published([make_row()])
    payload = json.loads(published.paths["GEOJSON_PATH"].read_text())
    del payload["features"][0]["properties"]["nta"]
    published.paths["GEOJSON_PATH"].write_text(json.dumps(payload))
    assert "missing 'nta'" in errors(result_for(published))


def test_an_empty_sid_is_fatal(published):
    published([make_row()])
    payload = json.loads(published.paths["GEOJSON_PATH"].read_text())
    payload["features"][0]["properties"]["sid"] = []
    published.paths["GEOJSON_PATH"].write_text(json.dumps(payload))
    assert "sid is empty" in errors(result_for(published))


def test_a_property_published_twice_is_fatal(published):
    published([make_row(sid="row-1"), make_row(sid="row-2", street="1 AVENUE")])
    payload = json.loads(published.paths["GEOJSON_PATH"].read_text())
    payload["features"][1]["properties"]["sid"] = payload["features"][0]["properties"]["sid"]
    published.paths["GEOJSON_PATH"].write_text(json.dumps(payload))
    assert "published twice" in errors(result_for(published))


def test_an_unsorted_sid_is_fatal(published):
    published([make_row()])
    payload = json.loads(published.paths["GEOJSON_PATH"].read_text())
    payload["features"][0]["properties"]["sid"] = ["row-zzz", "row-aaa"]
    published.paths["GEOJSON_PATH"].write_text(json.dumps(payload))
    assert "must be sorted" in errors(result_for(published))


def test_a_wrong_property_type_is_fatal(published):
    published([make_row()])
    payload = json.loads(published.paths["GEOJSON_PATH"].read_text())
    payload["features"][0]["properties"]["zip"] = 11238
    published.paths["GEOJSON_PATH"].write_text(json.dumps(payload))
    assert "properties.zip is number" in errors(result_for(published))


def test_a_content_hash_mismatch_is_fatal(published):
    published([make_row()])
    metadata = json.loads(published.paths["METADATA_PATH"].read_text())
    metadata["contentHash"] = "0" * 64
    published.paths["METADATA_PATH"].write_text(json.dumps(metadata))
    assert "metadata.contentHash" in errors(result_for(published))


def test_a_count_disagreement_is_fatal(published):
    published([make_row()])
    metadata = json.loads(published.paths["METADATA_PATH"].read_text())
    metadata["recordCount"] = 2
    published.paths["METADATA_PATH"].write_text(json.dumps(metadata))
    assert "metadata.recordCount 2 != 1" in errors(result_for(published))


def test_a_report_disagreement_is_fatal(published):
    published([make_row()])
    report = json.loads(published.paths["REPORT_PATH"].read_text())
    report["sidewalk"] = 5
    published.paths["REPORT_PATH"].write_text(json.dumps(report))
    assert "report.sidewalk 5" in errors(result_for(published))


def test_count_collapse_is_fatal(published):
    published([make_row()])
    result = validate_data.validate(min_records=1500)
    assert "record count collapse" in errors(result)


def test_unparseable_json_is_fatal(published):
    published([make_row()])
    published.paths["GEOJSON_PATH"].write_text("{not json")
    assert result_for(published).errors


def test_missing_artifacts_are_fatal(published):
    result = result_for(published)
    assert any("missing artifact" in e for e in result.errors)


# --------------------------------------------------------------------------- drift


def test_a_new_dining_type_is_drift_not_corruption(published):
    published([make_row()])
    payload = json.loads(published.paths["GEOJSON_PATH"].read_text())
    payload["features"][0]["properties"]["type"] = "mobile"
    published.paths["GEOJSON_PATH"].write_text(json.dumps(payload))

    result = result_for(published)
    assert "unknown type 'mobile'" in warnings(result)
    assert "report.sidewalk" in errors(result)  # the count no longer adds up
    assert "outside the NYC bounding box" not in errors(result)
    assert "must be a Point" not in errors(result)


def test_a_new_borough_is_drift(published):
    published([make_row()])
    payload = json.loads(published.paths["GEOJSON_PATH"].read_text())
    payload["features"][0]["properties"]["borough"] = "Staten Island"
    published.paths["GEOJSON_PATH"].write_text(json.dumps(payload))
    result = result_for(published)
    assert "unknown borough" not in warnings(result)  # it is a known borough
    assert "metadata.boroughs" in errors(result)


def test_a_genuinely_new_borough_is_drift(published):
    published([make_row()])
    payload = json.loads(published.paths["GEOJSON_PATH"].read_text())
    payload["features"][0]["properties"]["borough"] = "Yonkers"
    published.paths["GEOJSON_PATH"].write_text(json.dumps(payload))
    assert "unknown borough 'Yonkers'" in warnings(result_for(published))


def test_a_new_license_status_is_drift(published):
    published([make_row()])
    payload = json.loads(published.paths["GEOJSON_PATH"].read_text())
    payload["features"][0]["properties"]["status"] = "Expired"
    published.paths["GEOJSON_PATH"].write_text(json.dumps(payload))
    assert "unknown license_status 'Expired'" in warnings(result_for(published))


def test_a_short_zip_is_drift(published):
    published([make_row(postcode="0730")])
    result = result_for(published)
    assert "zip values are not 5" in warnings(result)


def test_a_short_nta_is_drift(published):
    published([make_row(nta2020="BK02")])
    assert "nta values are not 6" in warnings(result_for(published))


def test_an_unexpected_key_is_drift(published):
    published([make_row()])
    payload = json.loads(published.paths["GEOJSON_PATH"].read_text())
    payload["features"][0]["properties"]["seatingCapacity"] = 12
    published.paths["GEOJSON_PATH"].write_text(json.dumps(payload))
    assert "unexpected key 'seatingCapacity'" in warnings(result_for(published))


def test_strict_promotes_drift_to_failure(published, capsys):
    published([make_row(nta2020="BK02")])
    assert validate_data.main(["--strict", "--min-records", "0"]) == 1
    assert "--strict" in capsys.readouterr().err


def test_non_strict_drift_still_exits_zero(published, capsys):
    published([make_row(nta2020="BK02")])
    assert validate_data.main(["--min-records", "0"]) == 0
    captured = capsys.readouterr().out
    assert "SCHEMA DRIFT: 1 nta values are not 6 characters" in captured
    assert "ok — artifacts match the contract" in captured


def test_recorded_merge_anomalies_are_reported(published):
    rows = make_pair(license_types=("Sidewalk", "Sidewalk"), sid_prefix="row-dup")
    published(rows)
    assert "merge anomalies" in warnings(result_for(published))


def test_an_unexpected_rejection_reason_code_is_drift(published):
    published([make_row()])
    report = json.loads(published.paths["REPORT_PATH"].read_text())
    report["rejections"] = [
        {
            "name": "X",
            "street": "Y",
            "city": None,
            "borough": None,
            "latitude": None,
            "longitude": None,
            "reason": "because_i_said_so: no",
        }
    ]
    published.paths["REPORT_PATH"].write_text(json.dumps(report))
    assert "unknown reason code" in warnings(result_for(published))


def test_format_result_is_readable(published):
    published([make_row()])
    text = validate_data.format_result(result_for(published))
    assert "VALIDATION" in text
    assert "features 1" in text


def test_rejections_reconcile_with_the_counters(published):
    rows = [
        make_row(sid="row-ok"),
        make_row(sid="row-boro", borough=None),
        make_row(sid="row-geo", latitude="42.1264412", longitude="-70.8480884"),
    ]
    outcome = published(rows)
    rejected = outcome.report["rejected"]
    assert rejected == {
        "outOfBounds": 1,
        "unknownBorough": 1,
        "unparseableCoordinates": 0,
        "missingCoordinates": 0,
    }
    assert sum(rejected.values()) == len(outcome.report["rejections"]) == 2
    result = result_for(published)
    assert result.errors == []
    assert unexpected_warnings(result) == []


def test_an_artifact_set_with_nothing_publishable_is_rejected(published):
    published([make_row(borough=None)])
    assert "no features" in errors(result_for(published))
