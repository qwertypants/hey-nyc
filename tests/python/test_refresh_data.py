"""refresh_data.py orchestration, and the artifacts committed to the repo."""

from __future__ import annotations

import json

import pytest
from conftest import make_pair, make_row

import _common as C
import refresh_data
import validate_data


def write_raw(path, rows):
    path.write_text(json.dumps(rows, separators=(",", ":")), encoding="utf-8")


# --------------------------------------------------------------------------- orchestration


def test_skip_fetch_runs_the_whole_pipeline(isolated_paths, capsys):
    write_raw(isolated_paths["RAW_DATA_PATH"], make_pair() + [make_row(sid="row-c")])
    code = refresh_data.main(["--skip-fetch"])
    out = capsys.readouterr().out
    assert "[2/4] inspect" in out and "[3/4] clean" in out and "[4/4] validate" in out
    assert "skipped (--skip-fetch)" in out
    # Three source rows is far below the anti-collapse floor, so the last stage
    # fails loudly: the pipeline must not certify a dataset that lost its rows.
    assert code == 1
    assert "record count collapse" in out


def test_a_failing_stage_stops_the_run(isolated_paths, capsys):
    write_raw(isolated_paths["RAW_DATA_PATH"], [make_row()])
    # A raw file that no longer matches its fetch metadata must stop the pipeline.
    isolated_paths["FETCH_META_PATH"].write_text(
        json.dumps({"rowCount": 1, "responseSha256": "0" * 64, "sourceUpdatedAt": None})
    )
    code = refresh_data.main(["--skip-fetch"])
    assert code == 1
    assert "STOPPED at stage 'clean'" in capsys.readouterr().err


def test_skip_fetch_without_a_snapshot_fails(isolated_paths, capsys):
    code = refresh_data.main(["--skip-fetch"])
    assert code == 1
    assert "--skip-fetch" in capsys.readouterr().err


def test_a_failing_validate_stage_is_fatal(isolated_paths, monkeypatch, capsys):
    write_raw(isolated_paths["RAW_DATA_PATH"], [make_row()])
    monkeypatch.setattr(validate_data, "validate", lambda: validate_data.Result(errors=["boom"]))
    code = refresh_data.main(["--skip-fetch"])
    assert code == 1
    assert "STOPPED at stage 'validate'" in capsys.readouterr().err


def test_strict_promotes_drift_in_the_refresh(isolated_paths, monkeypatch, capsys):
    write_raw(isolated_paths["RAW_DATA_PATH"], [make_row()])
    monkeypatch.setattr(
        validate_data, "validate", lambda: validate_data.Result(warnings=["SCHEMA DRIFT: nta"])
    )
    assert refresh_data.main(["--skip-fetch", "--strict"]) == 1
    assert "--strict" in capsys.readouterr().err
    assert refresh_data.main(["--skip-fetch"]) == 0


def test_display_path_survives_a_path_outside_the_repo(tmp_path):
    assert C.display_path(C.GEOJSON_PATH) == "public/data/cafes.geojson"
    assert C.display_path(tmp_path / "x.json") == str(tmp_path / "x.json")


# --------------------------------------------------------------------------- committed artifacts


def _require(path):
    if not path.exists():
        pytest.skip(f"{path} is not present; run scripts/refresh_data.py")
    return path


def test_the_committed_geojson_matches_the_contract():
    _require(C.GEOJSON_PATH)
    result = validate_data.validate()
    assert result.errors == [], "\n".join(result.errors)
    assert result.warnings == [], "\n".join(result.warnings)


def test_the_committed_geojson_has_the_documented_shape():
    _require(C.GEOJSON_PATH)
    payload = json.loads(C.GEOJSON_PATH.read_text(encoding="utf-8"))
    assert payload["type"] == "FeatureCollection"
    assert len(payload["features"]) == 2000
    assert all(tuple(f["properties"]) == C.PROPERTY_ORDER for f in payload["features"])
    assert len({f["id"] for f in payload["features"]}) == 2000


def test_the_committed_metadata_agrees_with_the_geojson():
    _require(C.METADATA_PATH)
    metadata = json.loads(C.METADATA_PATH.read_text(encoding="utf-8"))
    report = json.loads(C.REPORT_PATH.read_text(encoding="utf-8"))
    payload = json.loads(C.GEOJSON_PATH.read_text(encoding="utf-8"))
    assert metadata["recordCount"] == len(payload["features"]) == report["publishedLocations"]
    assert metadata["contentHash"] == report["contentHash"] == C.content_hash(payload["features"])
    assert metadata["sourceRowCount"] == report["sourceRows"] == 2437
    assert metadata["counts"] == {
        "sidewalk": report["sidewalk"],
        "roadway": report["roadway"],
        "both": report["both"],
    }
    assert sum(metadata["boroughs"].values()) == metadata["recordCount"]
