"""Text normalisation: whitespace, nullish tokens, degenerate bbl, dates."""

from __future__ import annotations

import pytest
from conftest import make_row, only

import _common as C


# --------------------------------------------------------------------------- whitespace


def test_internal_whitespace_runs_are_collapsed(build):
    """The live data has `86 EAST    7 STREET` in 329 rows."""
    outcome = build([make_row(street="86 EAST    7 STREET")])
    properties = only(outcome)["properties"]
    assert properties["street"] == "86 EAST 7 STREET"
    assert outcome.pipeline["whitespaceCollapsed"] == 1


def test_leading_and_trailing_whitespace_is_stripped(build):
    outcome = build([make_row(assumed_name_s="  LUCALI  ")])
    assert only(outcome)["properties"]["name"] == "LUCALI"


def test_tabs_and_newlines_collapse_to_one_space(build):
    outcome = build([make_row(business_legal_name="GIN\tBLOSSOM\nBK  LLC")])
    assert only(outcome)["properties"]["legalName"] == "GIN BLOSSOM BK LLC"


def test_source_case_is_preserved_verbatim(build):
    outcome = build([make_row(assumed_name_s="Mess Hall", business_legal_name="Mess Hall LLC")])
    assert only(outcome)["properties"]["name"] == "Mess Hall"
    assert only(outcome)["properties"]["legalName"] == "Mess Hall LLC"


def test_normalised_text_helper():
    assert C.normalise_text("  a   b  ") == "a b"
    assert C.normalise_text(1234) == "1234"
    assert C.normalise_text(1234.0) == "1234"
    assert C.normalise_text(True) is None


@pytest.mark.parametrize("token", ["", "  ", "N/A", "NULL", "null", "-", "None"])
def test_nullish_tokens_become_null(token):
    assert C.normalise_text(token) is None


def test_nullish_neighbourhood_publishes_as_null(build):
    outcome = build([make_row(city="N/A")])
    assert only(outcome)["properties"]["neighborhood"] is None


# --------------------------------------------------------------------------- bbl


def test_full_bbl_is_kept_as_a_string(build):
    outcome = build([make_row(bbl="3019770033")])
    properties = only(outcome)["properties"]
    assert properties["bbl"] == "3019770033"
    assert isinstance(properties["bbl"], str)


@pytest.mark.parametrize("junk", ["1", "3", "0"])
def test_degenerate_bbl_becomes_null_and_is_counted(build, junk):
    outcome = build([make_row(bbl=junk)])
    assert only(outcome)["properties"]["bbl"] is None
    assert outcome.pipeline["degenerateBbl"] == 1


def test_missing_bbl_stays_missing_without_being_counted_as_degenerate(build):
    outcome = build([make_row(bbl=None)])
    assert only(outcome)["properties"]["bbl"] is None
    assert outcome.pipeline["degenerateBbl"] == 0


def test_short_but_plausible_bbl_is_preserved(build):
    """384 3 AVENUE -> 18830048 and 1701 1 AVENUE -> 115510024 are real parcels."""
    outcome = build([make_row(bbl="18830048")])
    assert only(outcome)["properties"]["bbl"] == "18830048"
    assert outcome.pipeline["degenerateBbl"] == 0


def test_non_numeric_bbl_is_degenerate():
    value, degenerate = C.normalise_bbl("30-19 77-03")
    assert value is None and degenerate is True


def test_degenerate_bbl_counted_across_merged_rows(build):
    outcome = build(
        [
            make_row(sid="row-1", license_type="Sidewalk", bbl="1"),
            make_row(sid="row-2", license_type="Roadway", bbl="3"),
        ]
    )
    assert outcome.pipeline["degenerateBbl"] == 2
    assert only(outcome)["properties"]["bbl"] is None


# --------------------------------------------------------------------------- dates


def test_iso_timestamps_are_truncated_to_a_calendar_date(build):
    outcome = build([make_row(license_issue_date="2026-06-12T14:19:32.000")])
    assert only(outcome)["properties"]["licenseIssued"] == "2026-06-12"


def test_already_truncated_dates_pass_through(build):
    outcome = build([make_row(license_expiration_date="2030-06-12")])
    assert only(outcome)["properties"]["licenseExpires"] == "2030-06-12"


def test_missing_dates_stay_null(build):
    outcome = build([make_row(license_issue_date=None, license_expiration_date=None)])
    properties = only(outcome)["properties"]
    assert properties["licenseIssued"] is None
    assert properties["licenseExpires"] is None


@pytest.mark.parametrize("value", ["06/12/2026", "2026-13-45T00:00:00.000", "soon", "20260612"])
def test_unparseable_dates_become_null(value):
    assert C.normalise_date(value) is None


def test_dates_are_not_a_rejection_reason(build):
    """A row with no dates is still a location: nulls are allowed by the contract."""
    outcome = build([make_row(license_issue_date=None)])
    assert len(outcome.features) == 1
    assert outcome.report["rejected"]["missingCoordinates"] == 0


# --------------------------------------------------------------------------- name


def test_name_falls_back_to_the_legal_name(build):
    outcome = build([make_row(assumed_name_s="")])
    assert only(outcome)["properties"]["name"] == "EMH 919 INC"


def test_name_prefers_the_assumed_name(build):
    outcome = build([make_row(assumed_name_s="EMMY")])
    assert only(outcome)["properties"]["name"] == "EMMY"


def test_comma_in_a_legal_name_survives(build):
    outcome = build([make_row(business_legal_name='18 GREENWICH AVENUE, LLC')])
    assert only(outcome)["properties"]["legalName"] == "18 GREENWICH AVENUE, LLC"


def test_non_ascii_names_survive(build):
    outcome = build([make_row(assumed_name_s="CAFÉ Ø")])
    assert only(outcome)["properties"]["name"] == "CAFÉ Ø"
