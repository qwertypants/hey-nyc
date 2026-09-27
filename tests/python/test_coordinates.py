"""Coordinate parsing and the NYC bounding box."""

from __future__ import annotations

import math

import pytest
from conftest import make_row, properties_of, reasons, only

import _common as C


def test_bbox_bounds_are_the_documented_ones():
    assert (C.LAT_MIN, C.LAT_MAX) == (40.40, 41.00)
    assert (C.LNG_MIN, C.LNG_MAX) == (-74.30, -73.65)


@pytest.mark.parametrize(
    "lat,lon",
    [
        (40.683381422171, -73.966407027011),  # Brooklyn
        (C.LAT_MIN, C.LNG_MIN),               # exactly on the lower corner
        (C.LAT_MAX, C.LNG_MAX),               # exactly on the upper corner
        (40.40, -73.65),
    ],
)
def test_inside_bbox(lat, lon):
    assert C.in_nyc_bbox(lat, lon) is True


@pytest.mark.parametrize(
    "lat,lon",
    [
        (42.1264412, -70.8480884),   # Boston, MA — the 2343 ENZO HOLDINGS row
        (40.6906523745, -73.41365668616),  # MOULINAS LLC, off the east edge
        (C.LAT_MIN - 0.01, -73.9),
        (40.7, C.LNG_MAX + 0.01),
        (40.7, C.LNG_MIN - 0.01),
    ],
)
def test_outside_bbox(lat, lon):
    assert C.in_nyc_bbox(lat, lon) is False


def test_parse_coordinate_accepts_socrata_strings_and_numbers():
    assert C.parse_coordinate("40.683381422171") == 40.683381422171
    assert C.parse_coordinate(40.683381422171) == 40.683381422171
    assert C.parse_coordinate(" 40.68 ") == 40.68


@pytest.mark.parametrize("value", ["", None, "N/A", "null", "-", "  "])
def test_parse_coordinate_rejects_nullish(value):
    with pytest.raises(C.MissingCoordinate):
        C.parse_coordinate(value)


def test_a_missing_coordinate_and_a_broken_one_are_different_reasons():
    assert C.coordinates_of({"latitude": None, "longitude": "1"})[2] == "missing_coordinates"
    assert C.coordinates_of({"latitude": "x", "longitude": "1"})[2] == "unparseable_coordinates"


def test_parse_coordinate_rejects_garbage():
    with pytest.raises(ValueError):
        C.parse_coordinate("not-a-number")


def test_boston_row_is_rejected_as_out_of_bounds(build):
    row = make_row(
        sid="row-enzo",
        business_legal_name="2343 ENZO HOLDINGS LLC",
        assumed_name_s="ENZO'S OF ARTHUR AVE",
        street="2339 & 2343 ARTHUR AVE",
        city="BRONX",
        borough="Bronx",
        postcode="10458",
        latitude="42.1264412",
        longitude="-70.8480884",
    )
    outcome = build([row])
    assert outcome.features == []
    assert reasons(outcome) == ["out_of_bounds"]
    rejection = outcome.report["rejections"][0]
    assert rejection["name"] == "ENZO'S OF ARTHUR AVE"
    assert rejection["borough"] == "Bronx"
    assert rejection["latitude"] == 42.1264412
    assert "outside the NYC bounding box" in rejection["reason"]


def test_missing_coordinate_is_rejected_not_guessed(build):
    outcome = build([make_row(latitude=None)])
    assert reasons(outcome) == ["missing_coordinates"]
    assert outcome.report["rejected"]["missingCoordinates"] == 1

    outcome = build([make_row(longitude="")])
    assert reasons(outcome) == ["missing_coordinates"]


def test_unparseable_coordinate_is_recorded_with_the_raw_value(build):
    outcome = build([make_row(latitude="forty degrees")])
    rejection = outcome.report["rejections"][0]
    assert rejection["reason"].startswith("unparseable_coordinates")
    assert "'forty degrees'" in rejection["reason"]
    assert outcome.report["rejected"]["unparseableCoordinates"] == 1


def test_coordinates_publish_as_lon_lat(build):
    properties = properties_of(build([make_row()]))
    feature = only(build([make_row()]))
    lon, lat = feature["geometry"]["coordinates"]
    assert lon == -73.966407027011
    assert lat == 40.683381422171
    assert all(math.isfinite(v) for v in (lon, lat))
    assert properties["id"].startswith("eoy-")
