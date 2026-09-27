"""Shared contract for the Eat Outside NYC data pipeline.

Every other module in this directory imports from here so the paths, the NYC
bounding box, the id recipe and the HTTP client are defined exactly once. If a
rule in docs/data-dictionary.md changes, it changes here and nowhere else.

Standard library only — see requirements.txt.
"""

from __future__ import annotations

import hashlib
import json
import random
import re
import socket
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Iterable

# --------------------------------------------------------------------------- paths

REPO_ROOT = Path(__file__).resolve().parent.parent
RAW_DIR = REPO_ROOT / "data" / "raw"
PROCESSED_DIR = REPO_ROOT / "data" / "processed"
PUBLIC_DATA_DIR = REPO_ROOT / "public" / "data"

RAW_DATA_PATH = RAW_DIR / "fpeh-f7ci.json"
FETCH_META_PATH = RAW_DIR / "fetch-meta.json"
GEOJSON_PATH = PUBLIC_DATA_DIR / "cafes.geojson"
METADATA_PATH = PUBLIC_DATA_DIR / "metadata.json"
REPORT_PATH = PROCESSED_DIR / "report.json"

# --------------------------------------------------------------------------- source

DATASET_ID = "fpeh-f7ci"
DATASET_NAME = "Dining Out NYC Locations"
PROVIDER = "New York City Department of Transportation"
ATTRIBUTION = "Department of Transportation (DOT)"
RESOURCE_URL = f"https://data.cityofnewyork.us/resource/{DATASET_ID}.json"
VIEW_URL = f"https://data.cityofnewyork.us/api/views/{DATASET_ID}.json"
SOURCE_PAGE = (
    "https://data.cityofnewyork.us/Transportation/Dining-Out-NYC-Locations/" + DATASET_ID
)

FETCH_LIMIT = 50000
HTTP_TIMEOUT = 60.0
MAX_ATTEMPTS = 4
BACKOFF_BASE_SECONDS = 1.0
BACKOFF_CAP_SECONDS = 30.0
USER_AGENT = "eat-outside-nyc-data-pipeline/1.0 (stdlib urllib; +https://github.com/eat-outside-nyc)"

# --------------------------------------------------------------------------- rules

# docs/data-dictionary.md §6. Padded well past the observed extent (lat
# 40.574-40.878, lng -74.144 -73.73 once the Boston outlier is gone) so ordinary
# geocoder jitter is never mistaken for corruption.
LAT_MIN, LAT_MAX = 40.40, 41.00
LNG_MIN, LNG_MAX = -74.30, -73.65

BOROUGHS = ("Manhattan", "Brooklyn", "Queens", "Bronx", "Staten Island")

LICENSE_TYPE_SIDEWALK = "Sidewalk"
LICENSE_TYPE_ROADWAY = "Roadway"
SOURCE_LICENSE_TYPES = (LICENSE_TYPE_SIDEWALK, LICENSE_TYPE_ROADWAY)
DINING_TYPES = ("sidewalk", "roadway", "both")

#: source license_type -> published `type`. `both` is derived at merge time and
#: has no source value.
LICENSE_TYPE_TO_DINING = {
    LICENSE_TYPE_SIDEWALK: "sidewalk",
    LICENSE_TYPE_ROADWAY: "roadway",
}
BOTH_PAIR = frozenset({LICENSE_TYPE_SIDEWALK, LICENSE_TYPE_ROADWAY})

#: Tokens Socrata and hand-edits use for "no value". Anything here becomes null.
NULLISH_TOKENS = frozenset(
    {"", "-", "N/A", "n/a", "NA", "NULL", "null", "Null", "NONE", "None", "none", "NaN", "nan"}
)

#: A real NYC BBL is 10 digits. The geocoder also emits "1" and "3"; those are
#: junk and become null. 8/9 digit values in the live data are genuine
#: (384 3 AVENUE -> 18830048), so the floor has to stay well below 10.
BBL_MIN_DIGITS = 5
#: A full borough-block-lot is 10 digits. Two live records are shorter.
BBL_CANONICAL_DIGITS = 10

ID_PREFIX = "eoy-"
ID_HEX_LENGTH = 12
ID_RE = re.compile(rf"^{re.escape(ID_PREFIX)}[0-9a-f]{{{ID_HEX_LENGTH}}}$")

DATE_RE = re.compile(r"^(\d{4})-(\d{2})-(\d{2})")

# --------------------------------------------------------------------------- schema

#: The published property set, in the order it is written. Mirrors
#: src/types/location.ts LocationProperties; both sides must change together.
PROPERTY_ORDER = (
    "id",
    "name",
    "legalName",
    "street",
    "neighborhood",
    "borough",
    "zip",
    "type",
    "status",
    "licenseIssued",
    "licenseExpires",
    "nta",
    "bbl",
    "sid",
)

#: Property name -> allowed JSON kinds, spelled the way a JS reader sees them.
PROPERTY_TYPES: dict[str, tuple[str, ...]] = {
    "id": ("string",),
    "name": ("string",),
    "legalName": ("string",),
    "street": ("string",),
    "neighborhood": ("string", "null"),
    "borough": ("string",),
    "zip": ("string",),
    "type": ("string",),
    "status": ("string",),
    "licenseIssued": ("string", "null"),
    "licenseExpires": ("string", "null"),
    "nta": ("string", "null"),
    "bbl": ("string", "null"),
    "sid": ("array",),
}

# Rejection codes. The first four are the ones the frozen DataReport interface
# counts; the last two are pipeline-level codes that only fire on schema drift
# and are tracked separately so `rejected` keeps its exact published shape.
REJECTION_CODES = (
    "missing_coordinates",
    "unparseable_coordinates",
    "unknown_borough",
    "out_of_bounds",
    "unknown_license_type",
    "ambiguous_license_group",
)
#: Codes outside that four, which only fire on schema drift. Kept out of
#: `rejected` so the frozen DataReport shape survives, but never silent: every
#: occurrence lands in report.rejections and report.pipeline.
EXTENDED_REJECTION_CODES = (
    "unknown_license_type",
    "missing_identity",
    "ambiguous_license_group",
)


class PipelineError(Exception):
    """Anything the pipeline refuses to guess about."""


class FetchError(PipelineError):
    """Network, HTTP or payload failure while talking to NYC Open Data."""


class DataError(PipelineError):
    """The raw snapshot is missing, unreadable or not shaped like a row list."""


# --------------------------------------------------------------------------- time

def iso_now() -> str:
    """ISO-8601 UTC with a Z suffix, second resolution."""
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def epoch_to_iso(epoch: Any) -> str | None:
    """Socrata publishes rowsUpdatedAt as epoch seconds; keep it UTC."""
    if epoch is None:
        return None
    try:
        seconds = int(epoch)
    except (TypeError, ValueError):
        return None
    return datetime.fromtimestamp(seconds, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


# --------------------------------------------------------------------------- text


def normalise_text(value: Any) -> str | None:
    """Collapse whitespace runs and turn the usual empty spellings into None.

    Never case-folds: the source publishes UPPERCASE names and we publish them
    verbatim (docs/data-dictionary.md §6, "deliberately not repaired").
    """
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        # Socrata types most columns as text but a stray numeric is still data.
        if isinstance(value, float) and value.is_integer():
            value = int(value)
        value = str(value)
    if not isinstance(value, str):
        return None
    collapsed = " ".join(value.split())
    if collapsed in NULLISH_TOKENS:
        return None
    return collapsed or None


def normalise_bbl(value: Any) -> tuple[str | None, bool]:
    """Return (bbl, was_degenerate). A real BBL is 10 digits; junk becomes None."""
    text = normalise_text(value)
    if text is None:
        return None, False
    if not text.isdigit():
        return None, True
    if len(text) < BBL_MIN_DIGITS:
        return None, True
    return text, False


def normalise_date(value: Any) -> str | None:
    """`2026-06-12T14:19:32.000` -> `2026-06-12`. Unparseable stays None."""
    if isinstance(value, datetime):
        return value.date().isoformat()
    text = normalise_text(value)
    if text is None:
        return None
    match = DATE_RE.match(text)
    if not match:
        return None
    try:
        datetime(int(match.group(1)), int(match.group(2)), int(match.group(3)))
    except ValueError:
        return None
    return text[:10]


class MissingCoordinate(ValueError):
    """The value is absent, so there is nothing to parse."""


def parse_coordinate(value: Any) -> float:
    """Parse a latitude/longitude.

    Raises MissingCoordinate when the value is absent and ValueError when it is
    present but not a number, so a rejection can say which of the two happened.
    """
    if isinstance(value, bool):
        raise ValueError(f"not a coordinate: {value!r}")
    if isinstance(value, (int, float)):
        return float(value)
    text = normalise_text(value)
    if text is None:
        raise MissingCoordinate("missing coordinate")
    return float(text)


def coordinates_of(row: dict) -> tuple[float | None, float | None, str | None]:
    """Return (lat, lon, failure_code). failure_code is None on success."""
    for column in ("latitude", "longitude"):
        try:
            parse_coordinate(row.get(column))
        except MissingCoordinate:
            return None, None, "missing_coordinates"
        except (TypeError, ValueError):
            return None, None, "unparseable_coordinates"
    lat, _, _ = (parse_coordinate(row.get("latitude")), 0, 0)
    lon, _, _ = (parse_coordinate(row.get("longitude")), 0, 0)
    return lat, lon, None


def in_nyc_bbox(lat: float, lon: float) -> bool:
    return LAT_MIN <= lat <= LAT_MAX and LNG_MIN <= lon <= LNG_MAX


def location_id(legal_name: str, street: str) -> str:
    """`eoy-` + 12 hex chars of sha1("legalName|street").

    Depends on neither Socrata row order nor `:id`, so two refreshes that
    differ only in row order produce byte-identical output (docs §5). The id
    is part of the frozen contract, so changing this recipe is a contract
    change: see docs/adr/0001-freeze-the-location-schema.md
    """
    digest = hashlib.sha1(f"{legal_name}|{street}".encode("utf-8")).hexdigest()
    return ID_PREFIX + digest[:ID_HEX_LENGTH]


# --------------------------------------------------------------------------- json


def canonical_json(value: Any) -> str:
    """Byte-stable serialisation: sorted keys, no spaces, real UTF-8."""
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def compact_json(value: Any) -> str:
    """File serialisation: stable key order as inserted, no pretty printing."""
    return json.dumps(value, separators=(",", ":"), ensure_ascii=False)


def content_hash(features: Iterable[dict]) -> str:
    """sha256 over the canonical serialisation of the id-sorted feature list.

    The hash never covers itself: it is stored in metadata.json and report.json,
    neither of which is an input. That is what makes the daily refresh able to
    tell a real change from a re-run, so do not widen it.

    See docs/adr/0002-hash-features-never-the-timestamp.md
    """
    ordered = sorted(features, key=lambda f: f.get("id", ""))
    return hashlib.sha256(canonical_json(ordered).encode("utf-8")).hexdigest()


def sha256_hex(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def write_text(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="\n") as handle:
        handle.write(text)


def write_json_file(path: Path, value: Any) -> bytes:
    """Write compact JSON with a trailing newline. Returns the bytes written."""
    payload = (compact_json(value) + "\n").encode("utf-8")
    write_text(path, payload.decode("utf-8"))
    return payload


def display_path(path: Path) -> str:
    """Repo-relative when possible, absolute otherwise (tests use tmp dirs)."""
    try:
        return str(path.relative_to(REPO_ROOT))
    except ValueError:
        return str(path)


def read_json_file(path: Path) -> Any:
    try:
        raw = path.read_text(encoding="utf-8")
    except FileNotFoundError as exc:
        raise DataError(f"missing file: {path}") from exc
    except OSError as exc:
        raise DataError(f"cannot read {path}: {exc}") from exc
    try:
        return json.loads(raw)
    except json.JSONDecodeError as exc:
        raise DataError(f"{path} is not valid JSON: {exc}") from exc


def load_raw_rows(path: Path | None = None) -> list[dict]:
    """Read the raw snapshot. Never falls back to anything else."""
    target = path or RAW_DATA_PATH
    payload = read_json_file(target)
    if not isinstance(payload, list):
        raise DataError(f"{target} must contain a JSON array of rows, got {type(payload).__name__}")
    bad = [i for i, row in enumerate(payload) if not isinstance(row, dict)]
    if bad:
        raise DataError(f"{target}: {len(bad)} entries are not objects (first at index {bad[0]})")
    return payload


def load_fetch_meta(path: Path | None = None) -> dict | None:
    target = path or FETCH_META_PATH
    if not target.exists():
        return None
    payload = read_json_file(target)
    return payload if isinstance(payload, dict) else None


# --------------------------------------------------------------------------- http


def resource_url(limit: int = FETCH_LIMIT, select: str | None = None) -> str:
    params: dict[str, str] = {"$limit": str(limit)}
    if select:
        params["$select"] = select
    return f"{RESOURCE_URL}?{urllib.parse.urlencode(params)}"


def resource_select(view_meta: dict | None) -> str:
    """`$select` for the row endpoint.

    Socrata only returns the system `:id` when it is named explicitly, and
    `sid` is the only route back to the canonical row, so it has to be asked for.
    The `:@computed_region_*` pseudo-columns are dropped by `*,:id`; name them
    from the view metadata so the raw snapshot still matches the 23 columns the
    data dictionary documents.
    """
    parts = ["*", ":id"]
    if isinstance(view_meta, dict):
        for column in view_meta.get("columns", []) or []:
            field = str((column or {}).get("fieldName", ""))
            if field.startswith(":@computed_region"):
                parts.append(field)
    return ",".join(parts)


def _backoff_delay(attempt: int, rng: Callable[[], float]) -> float:
    """Bounded exponential backoff with jitter, so retries do not sync up."""
    base = min(BACKOFF_CAP_SECONDS, BACKOFF_BASE_SECONDS * (2 ** (attempt - 1)))
    return base * (0.5 + 0.5 * rng())


def http_get(
    url: str,
    *,
    timeout: float = HTTP_TIMEOUT,
    max_attempts: int = MAX_ATTEMPTS,
    sleep: Callable[[float], None] = time.sleep,
    rng: Callable[[], float] = random.random,
    what: str = "response",
) -> bytes:
    """GET with bounded retries. Transient failures retry; everything else raises."""
    request = urllib.request.Request(
        url,
        headers={"Accept": "application/json", "User-Agent": USER_AGENT},
        method="GET",
    )
    last: Exception | None = None
    for attempt in range(1, max_attempts + 1):
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                return response.read()
        except urllib.error.HTTPError as exc:
            status = exc.code
            transient = status == 429 or 500 <= status <= 599
            if not transient:
                raise FetchError(
                    f"{what}: HTTP {status} {exc.reason} from {url} "
                    "(not a transient failure — refusing to retry)"
                ) from exc
            last = exc
        except (urllib.error.URLError, socket.timeout, TimeoutError, ConnectionError) as exc:
            last = exc
        except OSError as exc:  # pragma: no cover - defensive
            last = exc

        if attempt == max_attempts:
            break
        delay = _backoff_delay(attempt, rng)
        print(
            f"  ! {what} failed ({last!r}); retry {attempt + 1}/{max_attempts} in {delay:.1f}s",
            flush=True,
        )
        sleep(delay)

    raise FetchError(f"{what}: giving up after {max_attempts} attempts; last error: {last!r}")


def http_get_json(url: str, **kwargs: Any) -> tuple[Any, bytes]:
    """GET + parse. Malformed JSON is fatal, never retried and never ignored."""
    body = http_get(url, **kwargs)
    return parse_json_body(body, what=url), body


def parse_json_body(body: bytes, what: str = "response") -> Any:
    try:
        return json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise FetchError(f"{what}: response is not valid JSON ({exc})") from exc
