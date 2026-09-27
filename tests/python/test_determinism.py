"""Determinism: the same records must produce the same bytes, whatever the row order.

This is what lets the daily workflow skip a pointless commit, so it is tested
against shuffled input rather than trusted.
"""

from __future__ import annotations

import hashlib
import json
import random

from conftest import make_pair, make_row

import _common as C


def sample_rows() -> list[dict]:
    rows: list[dict] = []
    rows += make_pair(sid_prefix="row-a")
    rows.append(make_row(sid="row-b", business_legal_name="SWEETGREEN NEW YORK LLC"))
    rows.append(make_row(sid="row-c", street="1 AVENUE", business_legal_name="AVENUE ONE LLC"))
    rows.append(
        make_row(
            sid="row-d",
            assumed_name_s="Mess Hall",
            business_legal_name="Mess Hall LLC",
            street="2194 FRDRCK DGLS BLVD",
            borough="Manhattan",
            city="NEW YORK",
            postcode="10462",
            latitude="40.8808",
            longitude="-73.9251",
        )
    )
    rows.append(
        make_row(
            sid="row-e",
            assumed_name_s="CAFÉ Ø",
            business_legal_name="CAFÉ Ø LLC",
            street="86 EAST    7 STREET",
        )
    )
    return rows


def shuffled(rows: list[dict], seed: int) -> list[dict]:
    out = list(rows)
    random.Random(seed).shuffle(out)
    return out


def test_ids_are_stable_across_shuffled_input(build):
    reference = {f["properties"]["street"]: f["id"] for f in build(sample_rows()).features}
    for seed in range(12):
        outcome = build(shuffled(sample_rows(), seed))
        current = {f["properties"]["street"]: f["id"] for f in outcome.features}
        assert current == reference


def test_ids_follow_the_documented_recipe(build):
    outcome = build([make_row()])
    expected = C.location_id("EMH 919 INC", "919 FULTON STREET")
    assert only_id(outcome) == expected
    assert expected.startswith("eoy-") and len(expected) == 16
    digest = hashlib.sha1(b"EMH 919 INC|919 FULTON STREET").hexdigest()[:12]
    assert expected == "eoy-" + digest


def only_id(outcome) -> str:
    return outcome.features[0]["id"]


def test_ids_are_built_from_the_normalised_name_and_street(build):
    """Whitespace normalisation happens before the id, so `86 EAST  7 STREET`
    and `86 EAST 7 STREET` can never disagree about who they are."""
    tidy = build([make_row(street="86 EAST 7 STREET")])
    messy = build([make_row(street="86 EAST    7 STREET")])
    assert tidy.features[0]["id"] == messy.features[0]["id"]


def test_geojson_bytes_are_identical_for_shuffled_input(published):
    rows = sample_rows()
    published(rows)
    first = published.paths["GEOJSON_PATH"].read_bytes()
    for seed in range(8):
        published(shuffled(rows, seed))
        assert published.paths["GEOJSON_PATH"].read_bytes() == first


def test_content_hash_is_stable_for_shuffled_input(build):
    reference = build(sample_rows()).report["contentHash"]
    for seed in range(8):
        assert build(shuffled(sample_rows(), seed)).report["contentHash"] == reference


def test_content_hash_changes_when_a_record_changes(build):
    before = build(sample_rows()).report["contentHash"]
    rows = sample_rows()
    rows[0]["postcode"] = "99999"
    assert build(rows).report["contentHash"] != before


def test_content_hash_excludes_itself(published):
    """The hash covers the features, never metadata.json or report.json."""
    outcome = published(sample_rows())
    digest = C.content_hash(json.loads(published.paths["GEOJSON_PATH"].read_text())["features"])
    assert outcome.metadata["contentHash"] == digest
    assert outcome.report["contentHash"] == digest
    assert digest not in published.paths["GEOJSON_PATH"].read_text()


def test_features_are_sorted_by_id(build):
    outcome = build(sample_rows())
    ids = [f["id"] for f in outcome.features]
    assert ids == sorted(ids)


def test_property_key_order_is_the_contract_order(build):
    for feature in build(sample_rows()).features:
        assert tuple(feature) == ("type", "id", "geometry", "properties")
        assert tuple(feature["properties"]) == C.PROPERTY_ORDER


def test_geojson_is_compact_but_valid(published):
    published(sample_rows())
    text = published.paths["GEOJSON_PATH"].read_text(encoding="utf-8")
    assert ", " not in text and '": ' not in text
    assert text.endswith("\n")
    payload = json.loads(text)
    assert payload["type"] == "FeatureCollection"
    assert len(payload["features"]) == 5


def test_written_metadata_and_report_are_compact_json(published):
    published(sample_rows())
    for key in ("METADATA_PATH", "REPORT_PATH"):
        text = published.paths[key].read_text(encoding="utf-8")
        assert ", " not in text
        assert json.loads(text)
