"""The Sidewalk + Roadway merge, and every shape that must be surfaced."""

from __future__ import annotations

from conftest import make_pair, make_row, only, reasons

import _common as C


def test_sidewalk_plus_roadway_becomes_both(build):
    outcome = build(make_pair())
    assert len(outcome.features) == 1
    properties = only(outcome)["properties"]
    assert properties["type"] == "both"
    assert properties["sid"] == sorted(properties["sid"])
    assert len(properties["sid"]) == 2
    assert outcome.report["mergedSidewalkAndRoadway"] == 1
    assert outcome.report["duplicatesRemoved"] == 1
    assert outcome.report["both"] == 1


def test_a_single_licence_keeps_its_own_type(build):
    for license_type, expected in (("Sidewalk", "sidewalk"), ("Roadway", "roadway")):
        outcome = build([make_row(license_type=license_type)])
        assert only(outcome)["properties"]["type"] == expected
        assert outcome.report["mergedSidewalkAndRoadway"] == 0
        assert outcome.report["duplicatesRemoved"] == 0


def test_two_establishments_at_the_same_street_stay_separate(build):
    rows = [
        make_row(sid="row-1", business_legal_name="A LLC", license_type="Sidewalk"),
        make_row(sid="row-2", business_legal_name="B LLC", license_type="Roadway"),
    ]
    outcome = build(rows)
    assert len(outcome.features) == 2
    assert {f["properties"]["type"] for f in outcome.features} == {"sidewalk", "roadway"}


def test_same_license_type_twice_is_surfaced_not_guessed(build):
    rows = make_pair(license_types=("Sidewalk", "Sidewalk"), sid_prefix="row-dup")
    outcome = build(rows)
    # The type is still derivable, so the establishment is published...
    assert len(outcome.features) == 1
    assert only(outcome)["properties"]["type"] == "sidewalk"
    # ...but the shape is upstream drift and must be reported.
    assert outcome.report["mergedSidewalkAndRoadway"] == 0
    anomalies = outcome.report["mergeAnomalies"]
    assert len(anomalies) == 1
    assert anomalies[0].startswith("repeated_license_type")
    assert "Sidewalk" in anomalies[0]
    assert outcome.pipeline["mergeAnomalies"] == 1


def test_a_group_of_three_is_surfaced(build):
    rows = make_pair(sid_prefix="row-tri")
    rows.append(make_row(sid="row-tri.2", license_type="Sidewalk"))
    outcome = build(rows)
    assert len(outcome.features) == 1
    assert any(a.startswith("group_of_3_plus") for a in outcome.report["mergeAnomalies"])


def test_disagreeing_coordinates_are_surfaced_and_resolved_deterministically(build):
    rows = make_pair(sid_prefix="row-geo")
    rows[1]["latitude"] = "40.683481422171"
    rows[1]["longitude"] = "-73.966317027011"
    outcome = build(rows)
    assert len(outcome.features) == 1
    assert only(outcome)["properties"]["type"] == "both"
    anomalies = outcome.report["mergeAnomalies"]
    assert any(a.startswith("coordinate_disagreement") for a in anomalies)
    # The published point is the lowest-:id member's, whatever the row order.
    assert only(outcome)["geometry"]["coordinates"] == [-73.966407027011, 40.683381422171]

    shuffled = build(list(reversed(rows)))
    assert only(shuffled)["geometry"]["coordinates"] == [-73.966407027011, 40.683381422171]


def test_identical_coordinates_produce_no_anomaly(build):
    outcome = build(make_pair())
    assert outcome.report["mergeAnomalies"] == []


def test_unknown_license_type_is_rejected_and_named(build):
    outcome = build([make_row(license_type="Mobile")])
    assert outcome.features == []
    assert reasons(outcome) == ["unknown_license_type"]
    assert outcome.pipeline["unknownLicenseType"] == 1
    assert "'Mobile'" in outcome.report["rejections"][0]["reason"]


def test_a_license_type_set_that_cannot_be_represented_is_rejected(build, monkeypatch):
    """If a new type is ever mapped, a mixed group must not be guessed at."""
    monkeypatch.setitem(C.LICENSE_TYPE_TO_DINING, "Mobile", "sidewalk")
    rows = [
        make_row(sid="row-m1", license_type="Sidewalk"),
        make_row(sid="row-m2", license_type="Mobile"),
    ]
    outcome = build(rows)
    assert outcome.features == []
    assert reasons(outcome) == ["ambiguous_license_group", "ambiguous_license_group"]
    assert outcome.pipeline["ambiguousLicenseGroup"] == 2
    assert any(a.startswith("ambiguous_license_group") for a in outcome.report["mergeAnomalies"])


def test_merged_scalar_fields_come_from_the_first_non_null_value(build):
    rows = [
        make_row(sid="row-a", license_type="Sidewalk", license_issue_date=None, nta2020="BK0204"),
        make_row(sid="row-b", license_type="Roadway", license_issue_date="2026-06-12T14:19:32.000"),
    ]
    properties = only(build(rows))["properties"]
    assert properties["licenseIssued"] == "2026-06-12"
    assert properties["nta"] == "BK0204"


def test_sid_is_sorted_so_the_order_of_the_licences_does_not_matter(build):
    rows = make_pair(sid_prefix="row-z")
    rows[0][":id"] = "row-zzz.1"
    rows[1][":id"] = "row-aaa.0"
    forward = only(build(rows))["properties"]["sid"]
    backward = only(build(list(reversed(rows))))["properties"]["sid"]
    assert forward == backward == ["row-aaa.0", "row-zzz.1"]


def test_a_row_without_a_street_cannot_get_an_id(build):
    outcome = build([make_row(street="")])
    assert outcome.features == []
    assert reasons(outcome) == ["missing_identity"]
    assert outcome.pipeline["missingIdentity"] == 1


def test_rejection_precedence_prefers_the_more_fundamental_finding(build):
    """A null borough plus a broken geocode is reported as a borough problem."""
    row = make_row(borough=None, latitude=None)
    outcome = build([row])
    assert reasons(outcome) == ["missing_coordinates"]  # coordinates come first

    row = make_row(borough=None, latitude="42.1264412", longitude="-70.8480884")
    outcome = build([row])
    assert reasons(outcome) == ["unknown_borough"]


def test_merge_groups_is_pure(build):
    """Same input, same output — no module state between runs."""
    rows = make_pair()
    first = build(rows)
    second = build(rows)
    assert first.features == second.features
    assert first.report == second.report


def test_expected_pipeline_arithmetic_on_a_two_row_pair(build):
    outcome = build(make_pair())
    report = outcome.report
    assert report["sourceRows"] == 2
    assert report["publishedLocations"] == 1
    assert report["sourceRows"] - sum(report["rejected"].values()) - report["duplicatesRemoved"] == 1
