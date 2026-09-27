"""fetch_data.py: bounded retries, loud failures, and honest provenance."""

from __future__ import annotations

import json
import socket
import urllib.error

import pytest
from conftest import make_row

import _common as C
import fetch_data


class FakeResponse:
    def __init__(self, body: bytes):
        self._body = body

    def read(self) -> bytes:
        return self._body

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


def http_error(code: int) -> urllib.error.HTTPError:
    return urllib.error.HTTPError("https://example.invalid", code, "boom", {}, None)


def url_error(reason="connection reset"):
    return urllib.error.URLError(socket.timeout(reason))


class Recorder:
    """Stands in for urllib.request.urlopen and records every attempt."""

    def __init__(self, outcomes):
        self.outcomes = list(outcomes)
        self.calls = 0
        self.sleeps: list[float] = []

    def __call__(self, request, timeout=None):
        self.calls += 1
        outcome = self.outcomes.pop(0)
        if isinstance(outcome, Exception):
            raise outcome
        return FakeResponse(outcome)

    @property
    def remaining(self):
        return len(self.outcomes)


# --------------------------------------------------------------------------- retries


@pytest.mark.parametrize(
    "failure",
    [http_error(429), http_error(500), http_error(502), http_error(503), url_error()],
)
def test_transient_failures_are_retried(monkeypatch, failure):
    recorder = Recorder([failure, failure, b'{"ok":true}'])
    monkeypatch.setattr(C.urllib.request, "urlopen", recorder)
    body = C.http_get("https://example.invalid", sleep=recorder.sleeps.append, rng=lambda: 0.5)
    assert body == b'{"ok":true}'
    assert recorder.calls == 3
    assert len(recorder.sleeps) == 2


def test_retries_stop_at_max_attempts(monkeypatch):
    recorder = Recorder([http_error(503)] * 4)
    monkeypatch.setattr(C.urllib.request, "urlopen", recorder)
    with pytest.raises(C.FetchError) as excinfo:
        C.http_get("https://example.invalid", sleep=recorder.sleeps.append)
    assert "giving up after 4 attempts" in str(excinfo.value)
    assert recorder.calls == C.MAX_ATTEMPTS == 4
    assert recorder.remaining == 0


def test_backoff_is_exponential_bounded_and_jittered():
    delays = [C._backoff_delay(attempt, rng=lambda: 1.0) for attempt in (1, 2, 3, 4, 9)]
    assert delays[:4] == [1.0, 2.0, 4.0, 8.0]
    assert delays[4] == C.BACKOFF_CAP_SECONDS
    low = C._backoff_delay(3, rng=lambda: 0.0)
    high = C._backoff_delay(3, rng=lambda: 1.0)
    assert low == 2.0 and high == 4.0


def test_slow_socket_timeouts_are_retried(monkeypatch):
    recorder = Recorder([socket.timeout("timed out"), b"[]"])
    monkeypatch.setattr(C.urllib.request, "urlopen", recorder)
    assert C.http_get("https://example.invalid", sleep=lambda _: None) == b"[]"


# --------------------------------------------------------------------------- loud failures


@pytest.mark.parametrize("code", [400, 401, 403, 404, 410])
def test_client_errors_are_not_retried(monkeypatch, code):
    recorder = Recorder([http_error(code)])
    monkeypatch.setattr(C.urllib.request, "urlopen", recorder)
    with pytest.raises(C.FetchError) as excinfo:
        C.http_get("https://example.invalid", sleep=lambda _: None)
    assert f"HTTP {code}" in str(excinfo.value)
    assert "refusing to retry" in str(excinfo.value)
    assert recorder.calls == 1


def test_malformed_json_is_fatal_and_not_retried():
    with pytest.raises(C.FetchError) as excinfo:
        C.parse_json_body(b"<html>not json</html>", what="rows")
    assert "not valid JSON" in str(excinfo.value)


def test_a_paged_envelope_is_refused(monkeypatch):
    recorder = Recorder([json.dumps({"results": [], "page": {}}).encode()])
    monkeypatch.setattr(C.urllib.request, "urlopen", recorder)
    with pytest.raises(C.FetchError) as excinfo:
        fetch_data.fetch_rows(view_meta={"columns": []})
    assert "PagedDataset envelope" in str(excinfo.value)


def test_an_empty_response_will_not_overwrite_the_snapshot(monkeypatch):
    recorder = Recorder([b"[]"])
    monkeypatch.setattr(C.urllib.request, "urlopen", recorder)
    with pytest.raises(C.FetchError) as excinfo:
        fetch_data.fetch_rows(view_meta={"columns": []})
    assert "zero rows" in str(excinfo.value)


def test_the_wrong_dataset_id_is_refused(monkeypatch):
    recorder = Recorder([json.dumps({"id": "abcd-1234"}).encode()])
    monkeypatch.setattr(C.urllib.request, "urlopen", recorder)
    with pytest.raises(C.FetchError) as excinfo:
        fetch_data.fetch_view_meta()
    assert "expected 'fpeh-f7ci'" in str(excinfo.value)


def test_main_exits_non_zero_and_prints_to_stderr(monkeypatch, capsys):
    recorder = Recorder([http_error(404)])
    monkeypatch.setattr(C.urllib.request, "urlopen", recorder)
    assert fetch_data.main() == 1
    assert "fetch_data:" in capsys.readouterr().err


# --------------------------------------------------------------------------- artifacts


def test_resource_url_requests_every_row_and_the_system_id():
    url = C.resource_url(C.FETCH_LIMIT, C.resource_select({}))
    assert "fpeh-f7ci.json" in url
    assert "%24limit=50000" in url
    assert "id" in C.resource_select({})


def test_computed_regions_are_asked_for_by_name():
    view = {"columns": [{"fieldName": "bbl"}, {"fieldName": ":@computed_region_yeji_bk3q"}]}
    assert C.resource_select(view) == "*,:id,:@computed_region_yeji_bk3q"


def test_fetch_meta_records_provenance_and_digest():
    body = b'[{"a":1}]'
    meta = fetch_data.build_fetch_meta([{"a": 1}], body, {"rowsUpdatedAt": 1790512249, "rowsUpdatedBy": "x"})
    assert meta["rowCount"] == 1
    assert meta["responseSha256"] == C.sha256_hex(body)
    assert meta["rowsUpdatedAt"] == 1790512249
    assert meta["sourceUpdatedAt"] == "2026-09-27T12:30:49Z"
    assert meta["retrieved_at"].endswith("Z")
    assert meta["datasetId"] == "fpeh-f7ci"


def test_raw_snapshot_is_written_byte_for_byte(isolated_paths, monkeypatch):
    rows = [make_row()]
    body = json.dumps(rows, separators=(",", ":")).encode()
    recorder = Recorder([json.dumps({"id": C.DATASET_ID, "rowsUpdatedAt": 1790512249}).encode(), body])
    monkeypatch.setattr(C.urllib.request, "urlopen", recorder)
    assert fetch_data.run() == 0
    assert isolated_paths["RAW_DATA_PATH"].read_bytes() == body
    assert C.read_json_file(isolated_paths["RAW_DATA_PATH"]) == rows
    meta = C.read_json_file(isolated_paths["FETCH_META_PATH"])
    assert meta["responseSha256"] == C.sha256_hex(body)
    assert meta["rowCount"] == 1


def test_running_twice_is_safe(isolated_paths, monkeypatch):
    body = json.dumps([make_row()], separators=(",", ":")).encode()
    view = json.dumps({"id": C.DATASET_ID, "rowsUpdatedAt": 1790512249}).encode()
    for _ in range(2):
        recorder = Recorder([view, body])
        monkeypatch.setattr(C.urllib.request, "urlopen", recorder)
        assert fetch_data.run() == 0
    assert C.read_json_file(isolated_paths["RAW_DATA_PATH"]) == [make_row()]


def test_a_stale_snapshot_is_never_used_as_a_fallback(isolated_paths, monkeypatch):
    isolated_paths["RAW_DATA_PATH"].write_text("[]")
    recorder = Recorder([http_error(404)])
    monkeypatch.setattr(C.urllib.request, "urlopen", recorder)
    assert fetch_data.main() == 1
    # The stale file is left exactly as it was, and no claim is made about it.
    assert isolated_paths["RAW_DATA_PATH"].read_text() == "[]"
    assert not isolated_paths["FETCH_META_PATH"].exists()
