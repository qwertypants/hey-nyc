"""_common.py: the shared rules, tested directly."""

from __future__ import annotations

import json

import pytest

import _common as C


def test_contract_constants():
    assert C.DATASET_ID == "fpeh-f7ci"
    assert C.ATTRIBUTION == "Department of Transportation (DOT)"
    assert C.PROVIDER == "New York City Department of Transportation"
    assert C.RESOURCE_URL == "https://data.cityofnewyork.us/resource/fpeh-f7ci.json"
    assert C.VIEW_URL == "https://data.cityofnewyork.us/api/views/fpeh-f7ci.json"
    assert C.FETCH_LIMIT == 50000
    assert C.MAX_ATTEMPTS == 4
    assert C.HTTP_TIMEOUT > 0


def test_artifact_paths_are_inside_the_repo():
    assert C.GEOJSON_PATH.relative_to(C.REPO_ROOT).as_posix() == "public/data/cafes.geojson"
    assert C.METADATA_PATH.relative_to(C.REPO_ROOT).as_posix() == "public/data/metadata.json"
    assert C.REPORT_PATH.relative_to(C.REPO_ROOT).as_posix() == "data/processed/report.json"
    assert C.RAW_DATA_PATH.relative_to(C.REPO_ROOT).as_posix() == "data/raw/fpeh-f7ci.json"
    assert C.FETCH_META_PATH.relative_to(C.REPO_ROOT).as_posix() == "data/raw/fetch-meta.json"


def test_location_id_recipe():
    import hashlib

    digest = hashlib.sha1(b"EMH 919 INC|919 FULTON STREET").hexdigest()[:12]
    assert C.location_id("EMH 919 INC", "919 FULTON STREET") == f"eoy-{digest}"
    assert C.ID_RE.match(C.location_id("a", "b"))
    assert not C.ID_RE.match("eoy-XYZ")
    assert not C.ID_RE.match("eoy-0123456789abcde")  # 13 hex chars
    assert not C.ID_RE.match("xoy-0123456789ab")


def test_canonical_json_is_key_order_independent():
    left = {"b": 1, "a": [3, {"z": 1, "y": 2}]}
    right = {"a": [3, {"y": 2, "z": 1}], "b": 1}
    assert C.canonical_json(left) == C.canonical_json(right)
    assert " " not in C.canonical_json(left)


def test_compact_json_keeps_insertion_order():
    assert C.compact_json({"b": 1, "a": 2}) == '{"b":1,"a":2}'


def test_content_hash_is_order_independent_but_value_sensitive():
    features = [{"id": "eoy-1", "properties": {"x": 1}}, {"id": "eoy-2", "properties": {"x": 2}}]
    assert C.content_hash(features) == C.content_hash(list(reversed(features)))
    changed = [{"id": "eoy-1", "properties": {"x": 1}}, {"id": "eoy-2", "properties": {"x": 3}}]
    assert C.content_hash(features) != C.content_hash(changed)
    assert len(C.content_hash(features)) == 64


def test_iso_now_is_utc_with_a_z():
    import re

    assert re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z", C.iso_now())


def test_write_and_read_json_round_trip(tmp_path):
    path = tmp_path / "nested" / "x.json"
    payload = {"b": 1, "a": "ø"}
    written = C.write_json_file(path, payload)
    assert written.endswith(b"\n")
    assert C.read_json_file(path) == payload
    assert path.read_bytes() == written


def test_read_json_errors_are_typed(tmp_path):
    with pytest.raises(C.DataError):
        C.read_json_file(tmp_path / "missing.json")
    broken = tmp_path / "broken.json"
    broken.write_text("{oops")
    with pytest.raises(C.DataError):
        C.read_json_file(broken)


def test_load_raw_rows_rejects_a_non_array(tmp_path):
    path = tmp_path / "raw.json"
    path.write_text('{"rows": []}')
    with pytest.raises(C.DataError):
        C.load_raw_rows(path)
    path.write_text("[1, 2]")
    with pytest.raises(C.DataError):
        C.load_raw_rows(path)


def test_missing_fetch_meta_is_not_an_error(tmp_path):
    assert C.load_fetch_meta(tmp_path / "nope.json") is None


def test_bbl_bounds():
    assert C.BBL_CANONICAL_DIGITS == 10
    assert C.normalise_bbl("3019770033") == ("3019770033", False)
    assert C.normalise_bbl("18830048") == ("18830048", False)
    assert C.normalise_bbl("3") == (None, True)
    assert C.normalise_bbl(None) == (None, False)


def test_license_type_map_is_exhaustive_and_bidirectional():
    assert set(C.LICENSE_TYPE_TO_DINING) == {"Sidewalk", "Roadway"}
    assert C.LICENSE_TYPE_TO_DINING["Sidewalk"] == "sidewalk"
    assert C.LICENSE_TYPE_TO_DINING["Roadway"] == "roadway"
    assert C.BOTH_PAIR == {"Sidewalk", "Roadway"}
    assert set(C.DINING_TYPES) == {"sidewalk", "roadway", "both"}
    # every published type is reachable from a source type or the merge
    reachable = set(C.LICENSE_TYPE_TO_DINING.values()) | {"both"}
    assert reachable == set(C.DINING_TYPES)


def test_coordinate_helpers():
    assert C.coordinates_of({"latitude": "40.7", "longitude": "-73.9"}) == (40.7, -73.9, None)
    assert C.coordinates_of({"latitude": "40.7"})[2] == "missing_coordinates"
    assert C.coordinates_of({"latitude": "x", "longitude": "-73.9"})[2] == "unparseable_coordinates"
    assert C.coordinates_of({"latitude": None, "longitude": "-73.9"})[2] == "missing_coordinates"


def test_backoff_is_bounded_by_the_cap():
    for attempt in range(1, 12):
        assert 0 <= C._backoff_delay(attempt, lambda: 0.99) <= C.BACKOFF_CAP_SECONDS
