"""Borough is the validity gate. Postcode deliberately is not."""

from __future__ import annotations

import pytest
from conftest import BASE_ROW, make_row, only, reasons

import _common as C


def test_the_five_boroughs_are_the_known_set():
    assert set(C.BOROUGHS) == {
        "Manhattan",
        "Brooklyn",
        "Queens",
        "Bronx",
        "Staten Island",
    }


@pytest.mark.parametrize("borough", sorted(C.BOROUGHS))
def test_every_known_borough_survives(build, borough):
    outcome = build([make_row(borough=borough)])
    assert only(outcome)["properties"]["borough"] == borough
    assert reasons(outcome) == []


def test_borough_whitespace_is_normalised_before_the_check(build):
    outcome = build([make_row(borough="  Brooklyn  ")])
    assert only(outcome)["properties"]["borough"] == "Brooklyn"


def test_null_borough_is_rejected(build):
    outcome = build([make_row(borough=None)])
    assert reasons(outcome) == ["unknown_borough"]
    assert "borough=None" in outcome.report["rejections"][0]["reason"]


def test_jersey_city_pair_is_rejected_even_though_it_is_inside_the_bbox(build):
    rows = [
        make_row(
            sid=f"row-jersey.{i}",
            business_legal_name="113 FRANKLIN DINING LLC" if i == 0 else "LAND RESTAURANT CORP",
            assumed_name_s="MADELINE'S" if i == 0 else "SERENECO",
            street="113 FRANKLIN ST",
            city="JERSEY CITY",
            borough=None,
            postcode="07307",
            latitude="40.742486524741",
            longitude="-74.049745655642",
            license_type=license_type,
        )
        for i, license_type in enumerate(("Sidewalk", "Roadway"))
    ]
    outcome = build(rows)
    assert outcome.features == []
    assert reasons(outcome) == ["unknown_borough", "unknown_borough"]
    # Coordinates are inside the loose bbox: only the borough check catches it.
    assert C.in_nyc_bbox(40.742486524741, -74.049745655642) is True


def test_amityville_is_rejected(build):
    outcome = build(
        [
            make_row(
                borough=None,
                city="AMITYVILLE",
                postcode="11701",
                latitude="40.6906523745",
                longitude="-73.41365668616",
            )
        ]
    )
    # Both rules fire; borough is the primary finding, the bbox breach is in the text.
    assert reasons(outcome) == ["unknown_borough"]
    assert outcome.report["rejections"][0]["reason"].startswith("unknown_borough")
    assert outcome.pipeline["unknownLicenseType"] == 0


def test_postcode_is_not_used_as_a_validity_gate(build):
    """A Manhattan row with a 113 (Queens) postcode must survive: borough wins."""
    row = make_row(borough="Manhattan", city="NEW YORK", postcode="11375")
    outcome = build([row])
    assert reasons(outcome) == []
    assert only(outcome)["properties"]["zip"] == "11375"
    assert only(outcome)["properties"]["borough"] == "Manhattan"


def test_leading_zero_postcode_survives_as_a_string(build):
    outcome = build([make_row(borough=None, postcode="07307")])
    assert outcome.features == []  # rejected on borough, not on the postcode

    outcome = build([make_row(postcode="07307", borough="Manhattan", city="JERSEY CITY")])
    assert only(outcome)["properties"]["zip"] == "07307"
    assert isinstance(only(outcome)["properties"]["zip"], str)


def test_unknown_borough_values_are_reported_verbatim(build):
    outcome = build([make_row(borough="NEW JERSEY")])
    assert reasons(outcome) == ["unknown_borough"]
    assert "NEW JERSEY" in outcome.report["rejections"][0]["reason"]


def test_borough_is_a_dotted_string_in_the_source():
    """Guards the fixture against a Socrata schema change."""
    assert BASE_ROW["borough"] in C.BOROUGHS
