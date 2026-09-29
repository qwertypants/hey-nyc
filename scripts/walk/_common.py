"""Shared contract for the Where NYC Walks data pipeline.

Every module in this directory imports from here so the paths, the two source
dataset ids, the id recipes, the NYC bounding box, the timestamp semantics and
the HTTP client are defined exactly once. This is the walk-side counterpart of
`scripts/_common.py`; it deliberately duplicates the HTTP client and the JSON
helpers rather than importing across feature boundaries, because the two
pipelines have different lifetimes (this one refreshes on a different cadence
and must stay runnable when the eat pipeline is not).

Standard library only — see requirements.txt.

THE TWO PROGRAMS ARE NOT THE SAME MEASUREMENT
============================================
NYC DOT runs two unrelated pedestrian counting programs and this pipeline
publishes both, side by side but never combined numerically:

  * "Bicycle and Pedestrian Counts" (ct66-47at) joined to "Bicycle and Pedestrian
    Count Sensors" (6up2-gnw8). Automated, 15-minute, high frequency. This is
    the LIVE program. As of 2026-09 it covers FOUR physical pedestrian
    counters citywide, two of which are still reporting. See
    docs/walk-data-analysis.md.
  * "Bi-Annual Pedestrian Counts" (cqsj-cfgu). Manual screenline sampling,
    114 locations, AM/midday/PM, two or three times a year since 2007. This is
    the HISTORICAL program and it is the one with real coverage.

A "Busy" label computed from the historical program and a "Busy" label computed
from a live sensor mean different things. They live in different files, are
classified by different rules, and are never summed. See
docs/where-nyc-walks.md.
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
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable, Iterable

# --------------------------------------------------------------------------- paths

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
RAW_DIR = REPO_ROOT / "data" / "raw" / "walk"
PROCESSED_DIR = REPO_ROOT / "data" / "processed" / "walk"
PUBLIC_DATA_DIR = REPO_ROOT / "public" / "data" / "walk"

#: 6up2-gnw8 — sensor metadata. Small (67 rows, 42 distinct ids), fetched whole.
SENSORS_RAW_PATH = RAW_DIR / "sensors-6up2-gnw8.json"
SENSORS_META_PATH = RAW_DIR / "sensors-fetch-meta.json"

#: ct66-47at — 21M rows, never fetched whole. `--since` / `--latest` only.
COUNTS_RAW_PATH = RAW_DIR / "pedestrian-counts-ct66-47at.json"
COUNTS_META_PATH = RAW_DIR / "counts-fetch-meta.json"

#: cqsj-cfgu — 114 rows, fetched whole.
HISTORY_RAW_PATH = RAW_DIR / "biannual-cqsj-cfgu.json"
HISTORY_META_PATH = RAW_DIR / "history-fetch-meta.json"

SENSOR_GEOJSON_PATH = PUBLIC_DATA_DIR / "sensors.geojson"
LATEST_PATH = PUBLIC_DATA_DIR / "latest.json"
HISTORICAL_GEOJSON_PATH = PUBLIC_DATA_DIR / "historical-locations.geojson"
HISTORICAL_PATTERNS_PATH = PUBLIC_DATA_DIR / "historical-patterns.json"
METADATA_PATH = PUBLIC_DATA_DIR / "metadata.json"
WALK_REPORT_PATH = PROCESSED_DIR / "report.json"

# --------------------------------------------------------------------------- sources

#: Automated counts. NEVER downloaded whole — see fetch_counts.py.
COUNTS_DATASET_ID = "ct66-47at"
COUNTS_NAME = "Bicycle and Pedestrian Counts"

#: Sensor metadata, for coordinates and capabilities.
SENSORS_DATASET_ID = "6up2-gnw8"
SENSORS_NAME = "Bicycle and Pedestrian Count Sensors"

#: Manual screenline counts. 114 rows, safe to fetch whole.
HISTORY_DATASET_ID = "cqsj-cfgu"
HISTORY_NAME = "Bi-Annual Pedestrian Counts"

PROVIDER = "New York City Department of Transportation"
ATTRIBUTION = "NYC Department of Transportation (DOT)"

SOURCES: dict[str, dict[str, str]] = {
    "counts": {
        "datasetId": COUNTS_DATASET_ID,
        "name": COUNTS_NAME,
        "source": f"https://data.cityofnewyork.us/Transportation/Bicycle-and-Pedestrian-Counts/{COUNTS_DATASET_ID}",
    },
    "sensors": {
        "datasetId": SENSORS_DATASET_ID,
        "name": SENSORS_NAME,
        "source": f"https://data.cityofnewyork.us/Transportation/Bicycle-and-Pedestrian-Count-Sensors/{SENSORS_DATASET_ID}",
    },
    "history": {
        "datasetId": HISTORY_DATASET_ID,
        "name": HISTORY_NAME,
        "source": f"https://data.cityofnewyork.us/Transportation/Bi-Annual-Pedestrian-Counts/{HISTORY_DATASET_ID}",
    },
}

API_BASE = "https://data.cityofnewyork.us"

FETCH_LIMIT = 50000
HTTP_TIMEOUT = 60.0
MAX_ATTEMPTS = 4
BACKOFF_BASE_SECONDS = 1.0
BACKOFF_CAP_SECONDS = 30.0
#: Carries the repository URL so a DOT operator can see who is asking, and so the
#: request is attributable. Matches `scripts/_common.py`, which names the same
#: repository — the two agents are the same project and should identify as one.
USER_AGENT = "eat-outside-nyc-walk-pipeline/1.0 (stdlib urllib; +https://github.com/qwertypants/hey-nyc)"

#: Socrata refuses an `$offset` at or beyond this, and silently truncating a
#: window would compute a baseline from a biased subset. Checked before every
#: paged fetch.
MAX_SOCRATA_OFFSET = 43000

# --------------------------------------------------------------------------- rules

#: Same generous box as the eat pipeline (scripts/_common.py), for consistency.
LAT_MIN, LAT_MAX = 40.40, 41.00
LNG_MIN, LNG_MAX = -74.30, -73.65

BOROUGHS = ("Manhattan", "Brooklyn", "Queens", "Bronx", "Staten Island")

NULLISH_TOKENS = frozenset(
    {"", "-", "N/A", "n/a", "NA", "NULL", "null", "Null", "NONE", "None", "none", "NaN", "nan"}
)

#: The counts dataset's categorical vocabularies, as observed. A value outside
#: these sets is schema drift: it is recorded, and it is fatal only when it
#: would make processing unsafe (see validate_walk.py).
TRAVEL_MODES = ("bike", "pedestrian", "scooter")
DIRECTIONS = ("in", "out")
GRANULARITIES = ("PT15M",)
COUNT_STATUSES = ("raw", "modified")

#: The source's own "timestamps are EST" claim, and why the data overrides it.
#: Kept here so the contradiction is recorded next to the parser that ignores
#: it, rather than in a comment somebody will delete as stale.
SOURCE_TZ_CLAIM = "EST (fixed, no daylight saving)"
SOURCE_TZ_ACTUAL = "America/New_York civil time (-05:00 winter, -04:00 summer)"

#: Fallback offset for a host with no tz database. The correct summer offset is
#: -04:00; see the timestamp section for why the source is civil time.
SOURCE_UTC_OFFSET = timedelta(hours=-5)

# --------------------------------------------------------------------------- ids

#: One published physical counter. Keyed on `counters_serial`, NOT on
#: `sensor_id` — see `resolve_counter_identity` below.
SENSOR_ID_PREFIX = "wsk-"
SENSOR_ID_LENGTH = 12
SENSOR_ID_RE = re.compile(rf"^{re.escape(SENSOR_ID_PREFIX)}[0-9a-f]{{{SENSOR_ID_LENGTH}}}$")

HISTORY_ID_PREFIX = "wsh-"
HISTORY_ID_LENGTH = 12
HISTORY_ID_RE = re.compile(rf"^{re.escape(HISTORY_ID_PREFIX)}[0-9a-f]{{{HISTORY_ID_LENGTH}}}$")

# --------------------------------------------------------------------------- schema

#: Sensors published in sensors.geojson. Order is the write order and mirrors
#: `SensorProperties` in src/types/walk.ts; both sides change together.
SENSOR_PROPERTY_ORDER = (
    "id",
    "name",
    "counterSerial",
    "sensorIds",
    "borough",
    "granularity",
    "directional",
    "firstObservation",
    "lastObservation",
    "active",
    "staleness",
    "activity",
    "count",
    "expected",
    "percentile",
    "ratio",
    "observationCount",
    "observedAt",
)

#: Property name -> allowed JSON kinds, spelled the way a JS reader sees them.
#: `"integer"` is deliberately distinct from `"number"`: a count is a count,
#: and a float where an integer belongs means the upstream parse lost
#: precision. `js_kind` maps a Python value to the kind it produces, because
#: `isinstance(True, int)` and `1.0` are both ints in Python but `"boolean"`
#: and `"number"` to a JS reader.
SENSOR_PROPERTY_TYPES: dict[str, tuple[str, ...]] = {
    "id": ("string",),
    "name": ("string",),
    "counterSerial": ("string",),
    "sensorIds": ("array",),
    "borough": ("string",),
    "granularity": ("string",),
    "directional": ("boolean",),
    "firstObservation": ("string", "null"),
    "lastObservation": ("string", "null"),
    "active": ("boolean",),
    "staleness": ("string",),
    "activity": ("string",),
    "count": ("integer", "null"),
    "expected": ("integer", "null"),
    "percentile": ("integer", "null"),
    "ratio": ("number", "null"),
    "observationCount": ("integer",),
    "observedAt": ("string", "null"),
}

#: The kind a Python value serialises to, as a JS reader sees it. Booleans are
#: checked before ints because `bool` subclasses `int` in Python.
def js_kind(value: Any) -> str:
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "boolean"
    if isinstance(value, int):
        return "integer"
    if isinstance(value, float):
        return "number"
    if isinstance(value, str):
        return "string"
    if isinstance(value, list):
        return "array"
    if isinstance(value, dict):
        return "object"
    return type(value).__name__

#: Manual count sites published in historical-locations.geojson.
HISTORY_PROPERTY_ORDER = (
    "id",
    "name",
    "street",
    "crossStreet",
    "borough",
    "inPedestrianVolumeIndex",
    "am",
    "md",
    "pm",
    "total",
    "change",
    "changeYears",
    "firstYear",
    "lastYear",
    "yearsMeasured",
    "latestSurvey",
    "trend",
)

HISTORY_PROPERTY_TYPES: dict[str, tuple[str, ...]] = {
    "id": ("string",),
    "name": ("string",),
    "street": ("string",),
    "crossStreet": ("string", "null"),
    "borough": ("string",),
    "inPedestrianVolumeIndex": ("boolean",),
    "am": ("integer", "null"),
    "md": ("integer", "null"),
    "pm": ("integer", "null"),
    "total": ("integer", "null"),
    "change": ("integer", "null"),
    "changeYears": ("string", "null"),
    "firstYear": ("integer", "null"),
    "lastYear": ("integer", "null"),
    "yearsMeasured": ("integer",),
    "latestSurvey": ("string", "null"),
    "trend": ("string",),
}

#: Activity buckets, ordered quiet -> busy. Thresholds are NOT invented: they
#: are percentiles of the sensor's OWN history, and the cut points are set in
#: ACTIVITY_CUTS below after inspecting real distributions. See
#: docs/walk-data-analysis.md for the evidence.
#:
#: ONE THING A PERCENTILE CANNOT SEE. Every level here is defined RELATIVE to
#: the bucket's own history, and a rank carries no information about how much
#: activity that history has ever contained. Measured on the live 56-day
#: snapshot (2026-09-28, 10,649 complete in+out intervals, 1,344 baseline keys):
#:
#:     61.0% of all intervals are exactly 0
#:     60.6% of baseline keys have a median of exactly 0
#:     341 keys are 0 in every one of their 7 or 8 samples
#:     the median key is zero in 87.5% of its samples
#:
#: So a zero-dominated bucket is the MAJORITY case, not an edge case, and a
#: pure rank scheme labels almost the whole dataset `typical` — including a
#: Monday-01:00 park path whose seven historical Mondays were all zero.
#: `activity_for` handles that with a rule keyed on the bucket's own published
#: `expected`, not with a special case for the number 0.
ACTIVITY_BUCKETS = ("unavailable", "quiet", "typical", "busy", "veryBusy")
#: Lower bound (inclusive) of each activity level, as a percentile of the
#: sensor's own historical distribution for the same weekday and time bucket.
#: Below MIN_SAMPLES the baseline is `unavailable` rather than a guess.
ACTIVITY_CUTS: tuple[tuple[str, int], ...] = (
    ("veryBusy", 90),
    ("busy", 75),
    ("typical", 25),
    ("quiet", 0),
)

#: `unavailable` is a state, not a level of activity, and is never reached by
#: a percentile cut.
ACTIVITY_LEVELS = ("quiet", "typical", "busy", "veryBusy")

#: The levels that ASSERT a bucket has established pedestrian volume, derived
#: from ACTIVITY_CUTS so there is one list and not two that can disagree.
#:
#: `quiet` is deliberately excluded: it is the one level a zero-expected bucket
#: may carry (it claims nothing about volume) and it is what the ladder itself
#: returns at percentile 0. A bucket whose median is zero may therefore never be
#: published as `typical`, `busy` or `veryBusy` — see `activity_for`.
ACTIVITY_LEVELS_REQUIRING_VOLUME = tuple(
    level for level, _floor in ACTIVITY_CUTS if level != "quiet"
)

#: A baseline computed from fewer than this many observations is `unavailable`.
#:
#: 7, not a round number, and not the 4 this started at. It is the observed
#: floor: an 8-week window gives 8 observations per (weekday, 15-minute) key
#: for 1241 of 1344 keys and exactly 7 for the other 103, where the window
#: boundary lands mid-day. Gating at 7 therefore costs a healthy refresh
#: nothing, while every degraded or short fetch publishes `unavailable` instead
#: of a confident label.
#:
#: It started at 4, which was wrong in a way worth recording. `percentile_rank`
#: credits half the ties, so the highest percentile any observation can reach
#: is 100 - 50/n. At n=4 that is 87.5, so `veryBusy` (p >= 90) was
#: STRUCTURALLY UNREACHABLE and the label silently degraded to "new record".
#: Do not lower this without redoing that arithmetic.
MIN_SAMPLES = 7

# --------------------------------------------------------------------------- freshness
#
# THRESHOLDS ARE SET BY THE FEED'S CADENCE, NOT BY WHAT FEELS LATE
# ================================================================
# The counts dataset is NOT a 15-minute stream, whatever its description
# implies. Measured 2026-09-28: `rowsUpdatedAt` was 7.6h old, the newest
# pedestrian row was ~14h old, and every COMPLETE day carries exactly 768
# pedestrian rows (2 live counters x 2 published ids x 2 directions x 96
# quarters) with the current day truncated partway through. DOT writes it in a
# daily batch.
#
# So a reading from this morning is not a sensor that has gone quiet — it is the
# most current reading the source can possibly hold. Thresholds built on the
# intuition of a live feed would label both working counters `stale` and tell a
# visitor their street counter is not reporting when in fact the batch simply
# has not run yet. The buckets are therefore in units of the batch:
#
#   fresh   within one batch cycle — the newest data the source can hold
#   stale   more than a cycle old, but recently enough that it was working
#   offline nothing for days — the counter is gone, or the feed is broken
#
# The 30-day figure that used to sit here as an unused `OFFLINE_AFTER` was the
# right instinct applied to the wrong question.

FRESH_WITHIN = timedelta(hours=30)
STALE_AFTER = timedelta(days=7)

#: A fourth state, and the only one that is not about the CLOCK.
#:
#: `fresh`/`stale`/`offline` answer "how long since this counter last spoke?".
#: A faulted counter answered that question perfectly — minutes ago — while
#: reporting nothing but zeroes for a month. Recency cannot see it, and the
#: consequence is worse than a stale label: `active` is derived from staleness,
#: so a dead counter was published as the FRESHEST, most live thing on the map.
#:
#: The measured evidence, from the 2026-09-28 snapshot, 57 days of pedestrian
#: rows over the two counters that report at all:
#:
#:     Concrete Plant Park   10 012 of 10 634 rows are 0, nonzero on 6 of 57
#:                           days, longest run of days with no nonzero
#:                           reading anywhere in them: 45
#:     Emmons Ave            4 357 of 10 636 rows are 0, longest such run: 1
#:
#: So the two counters separate 45-to-1, and the constant below sits an order of
#: magnitude from both. It is set on the HEALTHY counter's noise floor, not on
#: the failed one: a threshold at or below 1 flags a working sensor on a quiet
#: day, and the false positive would cost a real counter its label every time
#: the weather turned. Do not lower it without re-measuring both numbers above.
FAULT_ZERO_DAYS = 7

#: The fifth state, and the only one that is not a function of the clock. See
#: docs/adr/0007 for the decision and the alternatives it was chosen over.
STALENESS_STATES = ("fresh", "faulted", "stale", "offline", "unavailable")

#: Historical trend buckets, from the first survey to the most recent.
TREND_STATES = ("rising", "falling", "flat", "insufficient")

#: Direction labels in the historical program, as the source names them.
HISTORY_PERIODS = ("am", "md", "pm")
PERIOD_LABELS = {"am": "Morning", "md": "Midday", "pm": "Evening"}


class PipelineError(Exception):
    """Anything the pipeline refuses to guess about."""


class FetchError(PipelineError):
    """Network, HTTP or payload failure while talking to NYC Open Data."""


class DataError(PipelineError):
    """A raw snapshot is missing, unreadable or not shaped like a row list."""


# --------------------------------------------------------------------------- time
#
# TIMESTAMPS ARE NEW YORK CIVIL TIME, NOT FIXED EST
# ===================================================
# The source DOCUMENTATION says "Time is captured in EST time zone". The
# documentation is wrong, and the data proves it.
#
# The proof is the spring-forward hour. On the second Sunday of March, New York
# civil time skips 02:00-02:59 entirely. Fixed EST does not — under a fixed
# -05:00 offset those four quarter-hours exist every day of the year. The
# pedestrian series has ZERO rows in 02:00-02:59 on the spring-forward Sunday,
# in every year from 2023 to 2026, and a full complement on the Sundays either
# side:
#
#     2023-03-12 (spring fwd)  368 rows   prev 384   next 384
#     2024-03-10 (spring fwd) 1104 rows   prev 1152  next 1152
#     2025-03-09 (spring fwd) 1472 rows   prev 1536  next 1536
#     2026-03-08 (spring fwd) 1104 rows   prev 1152  next 1152
#
# Each is exactly 48 rows short — one hour of four quarter-hours across the
# twelve live (sensor, direction) pairs. That is the signature of a civil clock
# observing a DST transition, and it is not something a fixed offset can
# produce.
#
# So these are America/New_York civil timestamps: -05:00 in winter, -04:00 in
# summer. Getting this wrong shifts every summer observation by an hour against
# every winter one, which would move every time-of-day baseline by an hour for
# half the year — and would make `staleness_for` score a healthy summer sensor
# as an hour stale, which is precisely the confident-wrong-answer failure this
# project exists to avoid.
#
# `parse_source_timestamp` therefore resolves in the America/New_York zone. The
# one genuinely ambiguous case is the autumn fall-back hour, where 01:00-01:59
# occurs twice and the source cannot tell us which occurrence a row belongs to;
# `parse_source_timestamp` resolves it to the first (pre-transition, still on
# daylight time) and says so, and the timestamp tests pin the behaviour. Never
# hand a source timestamp to `datetime.fromisoformat` and let the runtime guess
# a zone — see tests/python/test_walk_timestamps.py.


def iso_now() -> str:
    """ISO-8601 UTC with a Z suffix, second resolution."""
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


#: zoneinfo is stdlib but the tz database may be absent on a slim container.
# Fall back to a fixed -05:00 so the pipeline still runs, at the cost of the
# one-hour summer offset. `parse_source_timestamp` reports which it got, so a
# degraded run is visible in the report rather than silent.
try:  # pragma: no cover - exercised by whichever branch the host provides
    from zoneinfo import ZoneInfo

    NYC_TZ: Any = ZoneInfo("America/New_York")
    NYC_TZ_IS_FULL = True
except Exception:  # pragma: no cover
    NYC_TZ = timezone(SOURCE_UTC_OFFSET)
    NYC_TZ_IS_FULL = False

#: True when the autumn fall-back hour resolved to the first (daylight-time)
#: occurrence. The source cannot distinguish the two, so this is a documented
#: assumption rather than a fact, and it is asserted in the timestamp tests.
FALLBACK_ASSUMED_FOLD = 0


def parse_source_timestamp(value: Any) -> datetime | None:
    """A source timestamp -> an aware datetime in New York civil time.

    The source publishes civil local time (see the section above: the
    spring-forward hour is absent from the data). So this resolves in
    America/New_York, NOT at a fixed -05:00 — a July timestamp is -04:00.

    Returns None for an absent or unparseable value. A missing observation is
    not a zero observation, so callers must handle None explicitly rather than
    defaulting to the epoch.
    """
    if isinstance(value, datetime):
        return value.astimezone(NYC_TZ) if value.tzinfo else value.replace(tzinfo=NYC_TZ)
    if not isinstance(value, str):
        return None
    text = value.strip()
    if text == "" or text in NULLISH_TOKENS:
        return None
    # Trim to seconds: the source appends `.000`, which `fromisoformat` on
    # Python 3.10 and earlier refuses.
    match = re.match(r"^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})", text)
    if match is None:
        return None
    try:
        naive = datetime.strptime(f"{match.group(1)}T{match.group(2)}", "%Y-%m-%dT%H:%M:%S")
    except ValueError:
        return None
    # `fold=0` makes the autumn 01:00-01:59 ambiguity deterministic: the first
    # occurrence, still on daylight time. The alternative is refusing to parse
    # real data, which is worse — the source offers no disambiguating column.
    return naive.replace(tzinfo=NYC_TZ, fold=FALLBACK_ASSUMED_FOLD)


def to_utc(moment: datetime) -> datetime:
    return moment.astimezone(timezone.utc)


def iso_utc(moment: datetime) -> str:
    return to_utc(moment).strftime("%Y-%m-%dT%H:%M:%SZ")


def to_nyc_wall_clock(moment: datetime) -> datetime:
    """Normalise any aware moment into New York civil time, for display."""
    return moment.astimezone(NYC_TZ)


#: 15-minute bucket label, in New York civil time. The baseline key is built
#: from this, so "typical at 14:00" means typical at 14:00 as a New Yorker
#: would read the clock.
def time_bucket(moment: datetime) -> str:
    return moment.strftime("%H:%M")


DAY_KEYS = ("mon", "tue", "wed", "thu", "fri", "sat", "sun")
#: Monday=0 in `weekday()`, matching the array order.
def day_key(moment: datetime) -> str:
    return DAY_KEYS[moment.weekday()]


# --------------------------------------------------------------------------- text


def normalise_text(value: Any) -> str | None:
    """Collapse whitespace runs and turn the usual empty spellings into None."""
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        if isinstance(value, float) and value.is_integer():
            value = int(value)
        value = str(value)
    if not isinstance(value, str):
        return None
    collapsed = " ".join(value.split())
    if collapsed in NULLISH_TOKENS:
        return None
    return collapsed or None


def parse_coordinate(value: Any) -> float | None:
    """A latitude/longitude as a float, or None when absent or not a number."""
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value)
    text = normalise_text(value)
    if text is None:
        return None
    try:
        return float(text)
    except ValueError:
        return None


def in_nyc_bbox(lat: float, lon: float) -> bool:
    return LAT_MIN <= lat <= LAT_MAX and LNG_MIN <= lon <= LNG_MAX


def parse_count(value: Any) -> int | None:
    """A `counts` cell. Absent, non-numeric and negative all become None.

    None means "no observation", never zero. Zero is a real measurement — a
    counter on an empty street at 4am genuinely reads 0 — and the distinction
    is the difference between "quiet" and "no recent reading".
    """
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value if value >= 0 else None
    if isinstance(value, float):
        return int(value) if value >= 0 else None
    text = normalise_text(value)
    if text is None:
        return None
    try:
        parsed = int(float(text))
    except ValueError:
        return None
    return parsed if parsed >= 0 else None


# --------------------------------------------------------------------------- ids

SENSOR_ID_RE_KEY = "counter_serial"


def sensor_id(counter_serial: str) -> str:
    """`wsk-` + 12 hex chars of sha1(counter_serial).

    Keyed on the physical counter, NOT on a Socrata `sensor_id`. The source
    publishes each physical pedestrian counter under two `sensor_id` values
    (one row tagged `bike, pedestrian`, one tagged `pedestrian`) carrying
    byte-identical count series. Keying on `sensor_id` would publish four
    phantom twins and double the city's measured pedestrian volume on any
    aggregate. See `resolve_counter_identity` and docs/walk-data-analysis.md.
    """
    digest = hashlib.sha1(counter_serial.encode("utf-8")).hexdigest()
    return SENSOR_ID_PREFIX + digest[:SENSOR_ID_LENGTH]


def history_id(source_id: Any, street: str, cross_street: str) -> str:
    """`wsh-` + 12 hex chars of sha1(loc|street|crossStreet).

    Depends on neither Socrata row order nor `:id`, so two refreshes that
    differ only in row order produce byte-identical output.
    """
    digest = hashlib.sha1(f"{source_id}|{street}|{cross_street}".encode("utf-8")).hexdigest()
    return HISTORY_ID_PREFIX + digest[:HISTORY_ID_LENGTH]


def sensor_id_from_source(sensor_id_value: str) -> str:
    """A source `sensor_id` -> the published id, for rows that never learn
    their `counters_serial`. Only used as a last resort by the validator; the
    pipeline itself must resolve the counter first."""
    return sensor_id(f"sensor_id:{sensor_id_value}")


# --------------------------------------------------------------------------- counter identity

#: A source sensor row declares its modes as a free-text list.
def travel_modes_of(row: dict) -> set[str]:
    raw = normalise_text(row.get("travelmodes") or row.get("travelmode"))
    if raw is None:
        return set()
    return {part.strip().lower() for part in raw.split(",") if part.strip()}


def is_pedestrian_capable(row: dict) -> bool:
    return "pedestrian" in travel_modes_of(row)


def resolve_counter_identity(rows: Iterable[dict]) -> list[dict]:
    """Collapse sensor rows into one record per PHYSICAL counter.

    The source publishes 67 rows for 42 distinct `id` values, and each of the
    four pedestrian counters appears under two `id` values with a differing
    `travelmodes` string but an identical `counters_serial`, identical
    coordinates and an identical count series.

    KEYING IS TWO-PASS, AND BOTH PASSES MATTER
    ------------------------------------------
    Pass 1 groups on `counters_serial`, so the bike+pedestrian / pedestrian ID
    pairs collapse together.

    Pass 2 then merges groups that describe the same physical site. Willis Ave
    publishes ONE series under TWO serials — YAH18055368 (a 2018 unit) and
    YAH22104565 (a 2021 unit) — and both serials carry both of that site's
    `id` values. A single-pass grouping therefore returns Willis TWICE, at
    identical coordinates with identical counts: the same 2x doubling the
    first pass exists to prevent, wearing a different hat. Pass 2 clusters on
    the SET of `sensor_ids` and on rounded coordinates, and keeps the
    lexicographically greatest serial as canonical, recording the others in
    `counterSerialAliases`.

    The invariant a caller can rely on: the returned groups partition the
    source `id` values, and no two groups share a coordinate or a sensor id.

    Returns one record per counter with a sorted `sensor_ids` list. Callers
    MUST sum across the collapsed group exactly once.
    """
    first_pass = _group_sensor_rows(rows, by="serial")
    merged = _merge_serial_aliases(first_pass)
    for group in merged:
        group["name"] = (
            sorted(group["names"], key=lambda value: (len(value), value))[0]
            if group["names"]
            else group["counterSerial"]
        )
        group["sensorIds"] = sorted(group["sensorIds"])
    merged.sort(key=lambda group: group["counterSerial"])
    return merged


def _group_sensor_rows(rows: Iterable[dict], *, by: str) -> list[dict]:
    """One pass of serial-then-site grouping. See resolve_counter_identity."""
    groups: dict[str, dict] = {}
    for row in rows:
        serial = normalise_text(row.get("counters_serial"))
        if serial is None:
            lat = parse_coordinate(row.get("lat"))
            lon = parse_coordinate(row.get("lon"))
            serial = (
                f"geo:{lat:.5f},{lon:.5f}"
                if lat is not None and lon is not None
                else f"id:{normalise_text(row.get('id')) or 'unknown'}"
            )
        group = groups.setdefault(
            serial,
            {
                "counterSerial": serial,
                "counterSerialAliases": set(),
                "sensorIds": set(),
                "names": [],
                "modes": set(),
                "lat": None,
                "lon": None,
                "granularity": None,
                "directional": False,
                "firstData": None,
                "lastData": None,
            },
        )
        source_id = normalise_text(row.get("id"))
        if source_id is not None:
            group["sensorIds"].add(source_id)
        name = normalise_text(row.get("name"))
        if name is not None and name not in group["names"]:
            group["names"].append(name)
        group["modes"] |= travel_modes_of(row)
        lat = parse_coordinate(row.get("lat"))
        lon = parse_coordinate(row.get("lon"))
        if lat is not None and lon is not None:
            group["lat"] = lat
            group["lon"] = lon
        granularity = normalise_text(row.get("granularity"))
        if granularity is not None:
            group["granularity"] = granularity
        if row.get("directional") in (True, "true", "True", "1"):
            group["directional"] = True
        # `firstdata` takes the EARLIEST and `lastdata` the LATIEST. Reading
        # both with the same comparison silently inverts `lastData`, which then
        # reports the OLDEST reading as the newest — a sensor that has been
        # dead for a year looks fresh.
        for column, target, keep in (
            ("firstdata", "firstData", min),
            ("lastdata", "lastData", max),
        ):
            moment = parse_source_timestamp(row.get(column) or row.get(column.capitalize()))
            if moment is None:
                continue
            current = group[target]
            if current is None or keep(moment, current) is not moment:
                group[target] = moment
    return list(groups.values())


#: Two rows within this many degrees are the same physical site. Coarser than
#: the eat pipeline's geocoder jitter allowance because these are fixed
#: counter installations, not geocoded addresses.
SITE_COORDINATE_EPSILON = 1e-4


def _merge_serial_aliases(groups: list[dict]) -> list[dict]:
    """Second pass: fold groups that share a sensor id or a coordinate.

    A counter replaced in the field keeps its `id` values and gains a new
    serial, so the two rows for one site are recognisable by either. Merging on
    the disjoint-set of `sensorIds` handles the id case; merging on rounded
    coordinates catches a site whose ids were both reissued.
    """
    merged: list[dict] = []

    def overlaps(candidate: dict) -> dict | None:
        for existing in merged:
            if existing["sensorIds"] & candidate["sensorIds"]:
                return existing
        for existing in merged:
            if (
                existing["lat"] is not None
                and candidate["lat"] is not None
                and abs(existing["lat"] - candidate["lat"]) <= SITE_COORDINATE_EPSILON
                and abs(existing["lon"] - candidate["lon"]) <= SITE_COORDINATE_EPSILON
            ):
                return existing
        return None

    for group in groups:
        existing = overlaps(group)
        if existing is None:
            merged.append(group)
            continue
        existing["sensorIds"] |= group["sensorIds"]
        existing["modes"] |= group["modes"]
        for name in group["names"]:
            if name not in existing["names"]:
                existing["names"].append(name)
        for key, keep in (("firstData", min), ("lastData", max)):
            if group[key] is not None and (
                existing[key] is None or keep(group[key], existing[key]) is not group[key]
            ):
                existing[key] = group[key]
        if existing["lat"] is None and group["lat"] is not None:
            existing["lat"] = group["lat"]
            existing["lon"] = group["lon"]
        existing["directional"] = existing["directional"] or group["directional"]
        if group["granularity"] is not None:
            existing["granularity"] = group["granularity"]
        # The canonical serial is the greatest, so it is a deterministic choice
        # independent of row order, and the losers are recorded rather than lost.
        #
        # The alias recorded is whichever of the two is NOT the canonical one —
        # the serial being DEMOTED, whichever side of the merge it happens to be
        # on. Recording the incoming serial instead made `counterSerialAliases`
        # empty whenever the older serial was grouped first and populated when
        # it was not: an order-dependent published field, in a pipeline whose
        # whole determinism argument is that row order cannot reach the
        # artifact. Neither "always the incoming one" nor "always the one
        # currently on `existing`" is order-independent, because which of the
        # two arrives second is a property of the source's row order.
        canonical = max(existing["counterSerial"], group["counterSerial"])
        demoted = min(existing["counterSerial"], group["counterSerial"])
        existing["counterSerialAliases"] |= {demoted} | {
            alias
            for alias in (group.get("counterSerialAliases") or set())
            if alias != canonical
        }
        existing["counterSerial"] = canonical

    for group in merged:
        group["counterSerialAliases"] = sorted(
            alias for alias in group.get("counterSerialAliases", set()) if alias != group["counterSerial"]
        )
    return merged


# --------------------------------------------------------------------------- statistics


def percentile_of(sorted_values: list[int | float], fraction: float) -> float | None:
    """Linear-interpolated percentile of an ALREADY SORTED list.

    `fraction` is 0..1. An empty list is None, never 0 — a baseline for which
    we have no samples is unknown, and treating it as zero would classify
    every sensor as maximally quiet.
    """
    if not sorted_values:
        return None
    if len(sorted_values) == 1:
        return float(sorted_values[0])
    position = fraction * (len(sorted_values) - 1)
    lower = int(position)
    upper = min(lower + 1, len(sorted_values) - 1)
    weight = position - lower
    return float(sorted_values[lower]) * (1 - weight) + float(sorted_values[upper]) * weight


def percentile_rank(value: int, sorted_values: list[int | float]) -> float | None:
    """Where `value` sits in `sorted_values`, 0..100.

    The share of historical observations at or below `value`, plus half of the
    ties, so a value equal to the median reads 50 rather than an arbitrary
    point inside the tie block. None when there is no history to compare.
    """
    if not sorted_values:
        return None
    below = 0
    equal = 0
    for candidate in sorted_values:
        if candidate < value:
            below += 1
        elif candidate == value:
            equal += 1
    total = len(sorted_values)
    return 100.0 * (below + equal / 2) / total


def activity_for(percentile: float | None, *, expected: int | None, count: int | None) -> str:
    """A reading -> an activity label. The rank is necessary, not sufficient.

    `percentile` is where the reading sits in its own bucket's history, and it
    is the right first cut. It cannot be the only cut, because a rank says
    nothing about how much activity the bucket has ever seen — see the
    ACTIVITY_BUCKETS note for the measured distribution.

    A bucket whose published `expected` is 0 has no established pedestrian
    volume, and every level on the ladder is defined relative to a volume, so
    the ladder does not apply to it:

    * **`count == 0` -> `quiet`.** The bucket is empty and expects to be
      empty. `typical` here is not a softer version of the truth, it is a
      different claim: it asserts that this path carries the foot traffic a
      `typical` path carries, when the median observation in its own history
      is that nobody was there.

    * **`count > 0` -> `unavailable`.** The measurement is real and is
      published as `count`, but there is no level to put it on. A blip above
      a history of seven identical zeros scores `100 - 50/n` on
      `percentile_rank` — the MAXIMUM the tie-credit formula can return — so
      the ladder would publish `veryBusy`, the strongest claim available, out
      of a distribution with zero variance and no upper support. `busy` and
      `veryBusy` are both unsupported here; `unavailable` says "we can tell you
      the number and not the level", which is the truth.

    `expected` is the PUBLISHED, rounded median rather than the raw one
    deliberately: the rule then recomputes from the published properties alone,
    so `validate_walk.py` can check it without re-deriving the baseline. One
    definition, checkable from the artifact.

    `percentile is None` still wins, because that is the sample-size gate
    (`MIN_SAMPLES`) and it is the stronger statement: we have no baseline at
    all, as against having a baseline that says zero.
    """
    if percentile is None:
        return "unavailable"
    if expected == 0:
        return "quiet" if count == 0 else "unavailable"
    for level, floor in ACTIVITY_CUTS:
        if percentile >= floor:
            return level
    return "quiet"


def staleness_for(observed_at: datetime | None, now: datetime) -> str:
    """Freshness from the age of the newest observation.

    Derived rather than taken from `status`: every pedestrian row in the
    source reports `status: 'raw'`, so the field carries no information at
    all and must not be presented as if it did. An absent observation is
    `unavailable`, never `fresh`.
    """
    if observed_at is None:
        return "unavailable"
    age = now - to_utc(observed_at)
    if age <= FRESH_WITHIN:
        return "fresh"
    if age <= STALE_AFTER:
        return "stale"
    return "offline"


def fault_run_days(series: Iterable[tuple[datetime, int | None]]) -> int:
    """Consecutive New York days, back from the newest, with NO nonzero reading.

    A day counts as a zero day only if it actually HAS readings and every one of
    them is 0. A day with no rows is a gap, and a gap terminates the run rather
    than extending it: silence is `staleness_for`'s question to answer, and
    letting a gap count as a zero would let a counter that stopped reporting
    drift toward `faulted` and be described as a counter that is reporting
    zeroes.

    The sum across both directions is what is tested, not each direction alone.
    A counter whose `in` and `out` legs each read 0 on different quarters would
    be faulting itself into existence, and per-direction splits are not how this
    gate decides anything.
    """
    per_day: dict[date, list[int | None]] = {}
    for moment, total in series:
        per_day.setdefault(to_nyc_wall_clock(moment).date(), []).append(total)

    run = 0
    for day in sorted(per_day, reverse=True):
        values = per_day[day]
        # A day with only absent counts is not a day of zeroes. It is a day the
        # source did not fill in, which is a different claim.
        if not values or all(value is None for value in values):
            break
        if any(value for value in values):
            break
        run += 1
    return run


def is_faulted(series: Iterable[tuple[datetime, int | None]]) -> bool:
    """Whether this counter is transmitting zeroes rather than measurements.

    See FAULT_ZERO_DAYS for the measurement the threshold comes from.
    """
    return fault_run_days(series) >= FAULT_ZERO_DAYS


# --------------------------------------------------------------------------- history column names
#
# The source spells its survey columns three different ways in one row — see
# HISTORY_COLUMN_RE below. 111 columns across 2007-2026, with 2019 measured for
# only 50 of 114 sites, 2020 present only as October, and 2024 surveyed in June
# rather than May. Column spellings are normalised here and nowhere else.

#: The source spells its survey columns THREE different ways in one row:
#   may_07_am ... june_24_md   (underscore, two-digit year)     97 columns
#   oct24_am  ... may26_pm     (no underscore)                  12 columns
#   may_22_p_m, may_23_p_m     (the PM period split as p + m)    2 columns
# 111 columns total. A regex that understands only the first two silently
# drops 224 populated observations (112 rows x 2 surveys). The third spelling
# is mapped onto the same `pm` period rather than treated as a new one, because
# it is the same measurement — DOT's own column label reads "May22_pM".
HISTORY_COLUMN_RE = re.compile(r"^(may|sept|oct|june)_?(\d{2})_(am|md|p?_?m)$")

#: Source period spelling -> the canonical period. `p_m` and `pm` are the same
#: period; `p?_?m` also matches a bare `m`, which does not occur in the data
#: but is accepted rather than dropping a column on a typo.
_PERIOD_CANONICAL = {"am": "am", "md": "md", "pm": "pm", "p_m": "pm", "m": "pm"}

#: Survey order, so "latest" means latest in survey order rather than in
#: column order (which is alphabetical and would put `sept_18` after `oct25`).
MONTH_ORDER = {"may": 5, "june": 6, "sept": 9, "oct": 10}


def history_columns(row: dict) -> list[dict]:
    """Every count column on a source row, as survey descriptors.

    Returns dicts of {year, month, period, column, value} sorted by survey
    date, oldest first. Columns absent from the row are simply not present,
    which is how a location that was not surveyed in a given year is
    represented: absence, not zero.
    """
    found: list[dict] = []
    for column, value in row.items():
        match = HISTORY_COLUMN_RE.match(column)
        if match is None:
            continue
        month_name, year_digits, period = match.groups()
        found.append(
            {
                "year": 2000 + int(year_digits),
                "month": MONTH_ORDER[month_name],
                "period": _PERIOD_CANONICAL[period],
                "column": column,
                "value": parse_count(value),
            }
        )
    found.sort(key=lambda item: (item["year"], item["month"], HISTORY_PERIODS.index(item["period"])))
    return found


def survey_label(year: int, month: int) -> str:
    names = {5: "May", 6: "June", 9: "September", 10: "October"}
    return f"{names[month]} {year}"


# --------------------------------------------------------------------------- json


def canonical_json(value: Any) -> str:
    """Byte-stable serialisation: sorted keys, no spaces, real UTF-8."""
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def compact_json(value: Any) -> str:
    return json.dumps(value, separators=(",", ":"), ensure_ascii=False)


def content_hash(features: Iterable[dict]) -> str:
    """sha256 over the canonical serialisation of the id-sorted feature list.

    Mirrors scripts/_common.py: the hash covers published features and never a
    timestamp, so a re-run that changes nothing produces the same hash and CI
    can skip the deploy. See docs/adr/0002.
    """
    ordered = sorted(features, key=lambda feature: feature.get("id", ""))
    return hashlib.sha256(canonical_json(ordered).encode("utf-8")).hexdigest()


def write_text(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="\n") as handle:
        handle.write(text)


def write_json_file(path: Path, value: Any) -> int:
    """Write compact JSON with a trailing newline. Returns bytes written."""
    payload = (compact_json(value) + "\n").encode("utf-8")
    write_text(path, payload.decode("utf-8"))
    return len(payload)


def display_path(path: Path) -> str:
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


def load_raw_rows(path: Path) -> list[dict]:
    payload = read_json_file(path)
    if not isinstance(payload, list):
        raise DataError(f"{path} must contain a JSON array of rows, got {type(payload).__name__}")
    return [row for row in payload if isinstance(row, dict)]


def read_fetch_meta(path: Path) -> dict | None:
    if not path.exists():
        return None
    payload = read_json_file(path)
    return payload if isinstance(payload, dict) else None


# --------------------------------------------------------------------------- http
#
# The HTTP client is duplicated from scripts/_common.py rather than imported.
# The eat pipeline's retry policy, timeouts and user agent are its own; a
# change to one must not silently retune the other, and the walk refresh runs
# on a different schedule from the daily eat job.


def resource_url(dataset_id: str, params: dict[str, str]) -> str:
    query = urllib.parse.urlencode(params)
    return f"{API_BASE}/resource/{dataset_id}.json?{query}"


def view_url(dataset_id: str) -> str:
    return f"{API_BASE}/api/views/{dataset_id}.json"


def sha256_hex(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def epoch_to_iso(epoch: Any) -> str | None:
    """Socrata publishes `rowsUpdatedAt` as epoch seconds; keep it UTC."""
    if epoch is None:
        return None
    try:
        seconds = int(epoch)
    except (TypeError, ValueError):
        return None
    return datetime.fromtimestamp(seconds, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


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
    """GET with bounded retries. Transient failures retry; everything else raises.

    A 4xx other than 429 is NOT transient: retrying a malformed `$where` four
    times just delays the error message that explains the actual problem.
    """
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
            transient = exc.code == 429 or 500 <= exc.code <= 599
            if not transient:
                raise FetchError(
                    f"{what}: HTTP {exc.code} {exc.reason} from {url} "
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


def parse_json_body(body: bytes, what: str = "response") -> Any:
    try:
        return json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise FetchError(f"{what}: response is not valid JSON ({exc})") from exc


def http_get_json(url: str, **kwargs: Any) -> tuple[Any, bytes]:
    """GET + parse. Malformed JSON is fatal, never retried and never ignored."""
    body = http_get(url, **kwargs)
    return parse_json_body(body, what=url), body
