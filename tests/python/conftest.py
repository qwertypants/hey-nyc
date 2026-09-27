"""Shared fixtures for the pipeline tests.

No network, no repo state: every test works on an inline dataset shaped like
`fpeh-f7ci`, and any test that needs the published artifacts gets them written
into a tmp directory.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
SCRIPTS_DIR = REPO_ROOT / "scripts"
for path in (REPO_ROOT, SCRIPTS_DIR):
    if str(path) not in sys.path:
        sys.path.insert(0, str(path))

import _common as C  # noqa: E402
import clean_data  # noqa: E402
import validate_data  # noqa: E402

#: A row as Socrata publishes it: every scalar is a string, `:id` is the system id.
BASE_ROW: dict = {
    ":id": "row-aaaa.bbbb.cccc",
    "business_legal_name": "EMH 919 INC",
    "assumed_name_s": "EMMY",
    "street": "919 FULTON STREET",
    "city": "BROOKLYN",
    "borough": "Brooklyn",
    "postcode": "11238",
    "license_type": "Sidewalk",
    "license_status": "Issued",
    "license_issue_date": "2026-06-12T14:19:32.000",
    "license_expiration_date": "2030-06-12T23:59:59.000",
    "latitude": "40.683381422171",
    "longitude": "-73.966407027011",
    "council_district": "35",
    "community_board": "302",
    "bin": "3056627",
    "bbl": "3019770033",
    "ct2020": "199",
    "nta2020": "BK0204",
    "location": {"type": "Point", "coordinates": [-73.966407027011, 40.683381422171]},
    ":@computed_region_92fq_4b7q": "48",
    ":@computed_region_f5dn_yrer": "68",
    ":@computed_region_yeji_bk3q": "2",
    ":@computed_region_sbqj_enih": "55",
}


def make_row(sid: str = "row-aaaa.bbbb.cccc", **overrides) -> dict:
    """A complete source row with the given overrides applied."""
    row = json.loads(json.dumps(BASE_ROW))  # deep copy, values are all JSON-safe
    row[":id"] = sid
    row.update(overrides)
    return row


def make_pair(sid_prefix: str = "row-pair", license_types=("Sidewalk", "Roadway"), **overrides) -> list[dict]:
    """The documented case: one establishment, two licences, identical coordinates."""
    rows = []
    for index, license_type in enumerate(license_types):
        row = make_row(sid=f"{sid_prefix}.{index}", license_type=license_type, **overrides)
        rows.append(row)
    return rows


@pytest.fixture
def base_row() -> dict:
    return make_row()


@pytest.fixture
def build():
    """`build(rows) -> Outcome` for the inline fixtures."""
    return lambda rows: clean_data.build_artifacts(rows)


@pytest.fixture
def isolated_paths(tmp_path, monkeypatch):
    """Point every artifact path at a tmp dir so tests never touch the repo."""
    paths = {
        "GEOJSON_PATH": tmp_path / "cafes.geojson",
        "METADATA_PATH": tmp_path / "metadata.json",
        "REPORT_PATH": tmp_path / "report.json",
        "RAW_DATA_PATH": tmp_path / "raw.json",
        "FETCH_META_PATH": tmp_path / "fetch-meta.json",
    }
    for name, value in paths.items():
        monkeypatch.setattr(C, name, value)
    return paths


@pytest.fixture
def published(isolated_paths, build):
    """Write a full artifact set from inline rows and return the paths + outcome."""
    written: dict = {}

    def _publish(rows):
        outcome = build(rows)
        clean_data.write_artifacts(
            outcome,
            geojson_path=isolated_paths["GEOJSON_PATH"],
            metadata_path=isolated_paths["METADATA_PATH"],
            report_path=isolated_paths["REPORT_PATH"],
        )
        written["outcome"] = outcome
        return written["outcome"]

    _publish.paths = isolated_paths  # type: ignore[attr-defined]
    _publish.result = lambda: validate_data.validate(min_records=0)  # type: ignore[attr-defined]
    return _publish


def features_of(outcome) -> list[dict]:
    return outcome.features


def only(outcome) -> dict:
    assert len(outcome.features) == 1, f"expected one feature, got {len(outcome.features)}"
    return outcome.features[0]


def properties_of(outcome) -> dict:
    return only(outcome)["properties"]


def reasons(outcome) -> list[str]:
    return [item["reason"].split(":")[0] for item in outcome.report["rejections"]]


def find(outcome, street: str) -> dict:
    for feature in outcome.features:
        if feature["properties"]["street"] == street:
            return feature
    raise AssertionError(f"no feature for street {street!r}")
