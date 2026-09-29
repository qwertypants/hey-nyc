#!/usr/bin/env python3
"""Raw snapshots -> public/data/walk/sensors.geojson and latest.json.

`build(...) -> Outcome` is pure: it takes parsed rows and returns features, the
latest-view payload and this half's report. It touches no clock except the `now`
it is handed and no filesystem at all, so a test can pin both. `write(...)` is
the only thing that writes.

THE ONE THING THIS MODULE IS FOR
=================================
The source publishes FOUR physical pedestrian counters under EIGHT `sensor_id`
values — one row tagged `bike, pedestrian` and one tagged `pedestrian`, sharing
a `counters_serial`, a position and a byte-identical count series. Aggregating
by `sensor_id` therefore doubles the city's entire measured pedestrian volume
while producing a map that looks entirely plausible. Measured on the live data
on 2026-09-28: `sum(counts)` over all 1,505,220 pedestrian rows is 7,484,824;
the physical figure is 3,742,412.

So the order of operations is load-bearing and is not negotiable:

    1. resolve `counters_serial` -> one record per PHYSICAL counter, then fold
       records that are the same site under two serials. BOTH halves of that
       live in `_common.resolve_counter_identity`, and both matter: pass 1
       collapses the bike+pedestrian / pedestrian id pairs, pass 2 collapses
       Willis Ave's 2018 and 2021 units, which publish one series under two
       serials. A local copy of the second half is what this file used to
       carry, and it is how the contract and its consumers drift apart.
    2. pick ONE representative source sensor id per counter, and SUM ONLY
       in + out for it

Step 2 is the step that is easy to get wrong in either direction. Summing both
twins is 2x. Summing a single direction is half. The twins are two
publications of one measurement, not two measurements, and in + out ARE two
measurements, so exactly one twin's in + out is the physical count.

A second trap lives in the freshness fields. Every pedestrian row in the source
says `status: 'raw'` — the vocabulary is real (bike rows use `modified`) but the
field is constant here, so it carries no information. Freshness is derived from
the age of the newest observation via `_common.staleness_for`, never from
`status`. A counter that stopped reporting months ago publishes
`staleness: 'offline'`, `active: false` and a NULL count: two of the four
counters are in exactly that state.

Usage:
    python3 scripts/walk/build_sensors.py [--out-dir DIR] [--now ISO] [--quiet]
"""

from __future__ import annotations

import argparse
import collections
import importlib.util
import math
import sys
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

if "walk_common" not in sys.modules:
    _spec = importlib.util.spec_from_file_location(
        "walk_common", Path(__file__).resolve().parent / "_common.py"
    )
    _walk_common = importlib.util.module_from_spec(_spec)
    sys.modules["walk_common"] = _walk_common
    _spec.loader.exec_module(_walk_common)
C = sys.modules["walk_common"]

#: Keys used to group count rows onto a physical counter's baseline. Both come
#: from `_common` and are computed in New York CIVIL time, so "typical at 08:00"
#: means typical at 08:00 on the clock a New Yorker would read. The source
#: documents its timestamps as fixed EST; the spring-forward hour is absent from
#: the data in every year 2023-2026, which a fixed offset cannot produce. See
#: the time section of `_common.py`.
BASELINE_KEYED_ON = "weekday+15min bucket, America/New_York civil time"

#: The published `expected` is the MEDIAN of that key's history. p25/p75/p90 are
#: computed too and live in the report only: `SENSOR_PROPERTY_ORDER` is frozen
#: and there is no field for them. The fraction list is the single place the
#: report's statistic names come from.
BASELINE_STATISTICS: tuple[tuple[str, float], ...] = (
    ("p25", 0.25),
    ("p50", 0.50),
    ("p75", 0.75),
    ("p90", 0.90),
)

#: 6up2-gnw8 publishes no borough column, so the published `borough` is derived
#: from the published `lat`/`lon`. These rectangles are coarse, deliberately so:
#: they exist to put a label on a point, not to be a boundary dataset. They are
#: ordered most-specific-first, and `nearest_edge_degrees` reports how close a
#: counter came to a boundary so a wrong label can never be quiet — two of the
#: four live counters sit within ~600 m of one.
BOROUGHS: tuple[tuple[str, float, float, float, float], ...] = (
    # (name, lat_min, lat_max, lon_min, lon_max)
    ("Bronx", 40.795, 40.930, -73.925, -73.700),
    ("Manhattan", 40.700, 40.895, -74.020, -73.905),
    ("Staten Island", 40.490, 40.660, -74.300, -74.035),
    ("Brooklyn", 40.545, 40.795, -74.045, -73.855),
    ("Queens", 40.540, 40.800, -73.960, -73.700),
)

#: ~550 m of latitude, ~420 m of longitude at 40.8 N. Inside this, warn.
NEAR_BORDER_DEGREES = 0.005

BOROUGH_DERIVATION = (
    "lat/lon rectangles: 6up2-gnw8 publishes no borough column, so the published "
    "borough is derived from the published coordinates and is approximate"
)


# --------------------------------------------------------------------------- small helpers


#: Every diagnostic this build can emit, so `report.pipeline` has the same shape
#: on a quiet day as on a broken one. A counter that only appears when it is
#: non-zero cannot be read by anything that is not also reading the code.
PIPELINE_KEYS = (
    "pedestrianSourceRows",
    "nonPedestrianSourceRows",
    "nonPedestrianResolved",
    "multiSerialCounters",
    "unresolvedCoordinates",
    "outsideBbox",
    "unknownBoroughs",
    "nearBoroughBorder",
    "unknownSensorIds",
    "nonPedestrianRows",
    "inRows",
    "outRows",
    "otherDirectionRows",
    "twinRowsCollapsed",
    "twinDivergence",
    "unparseableTimestamps",
    "nullCounts",
    "incompleteIntervals",
    "observedIntervals",
    "insufficientBaselineSamples",
    "zeroMedianIntervals",
    "aboveZeroReadingInZeroBaseline",
    "suppressedOfflineBaselines",
    "faultedCounters",
    "longestZeroDayRun",
)


def round_half_up(value: float) -> int:
    """Round to the nearest integer, halves up.

    `round()` is banker's rounding, so a median of 122.5 would publish as 122
    on one refresh and 123 on the next depending on the parity of the
    neighbour. A published integer that wobbles is a published integer that
    looks like a data change.
    """
    return math.floor(value + 0.5)


def borough_for(lat: float, lon: float) -> str | None:
    for name, lat_min, lat_max, lon_min, lon_max in BOROUGHS:
        if lat_min <= lat <= lat_max and lon_min <= lon <= lon_max:
            return name
    return None


def nearest_edge_degrees(lat: float, lon: float) -> float | None:
    """How far the point is from the nearest edge of the rectangle it matched."""
    for _name, lat_min, lat_max, lon_min, lon_max in BOROUGHS:
        if lat_min <= lat <= lat_max and lon_min <= lon <= lon_max:
            return min(lat - lat_min, lat_max - lat, lon - lon_min, lon_max - lon)
    return None


def parse_now(value: Any) -> datetime:
    """`--now`, an ISO-8601 UTC instant, as an aware datetime. Defaults to now.

    Injected so a build is reproducible: `staleness` depends on the clock, so a
    no-op re-run only stays byte-identical if the clock is pinned.
    """
    if value is None:
        return datetime.now(timezone.utc)
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    text = str(value).strip().replace("Z", "+00:00")
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError as exc:
        raise C.PipelineError(f"could not read {value!r} as an ISO-8601 instant: {exc}") from exc
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


# --------------------------------------------------------------------------- counters


@dataclass
class Counter:
    """One physical pedestrian counter, after the twins are collapsed."""

    counterSerial: str
    sensorIds: list[str]
    name: str
    lat: float | None
    lon: float | None
    granularity: str | None
    directional: bool
    #: Every serial that resolved to this counter, canonical one included. One
    #: entry unless the source publishes one physical counter under two serials,
    #: which it does — see `_common.resolve_counter_identity` pass 2.
    serialAliases: list[str] = field(default_factory=list)
    #: How many 6up2-gnw8 rows fed this counter. Counted from the snapshot in
    #: `build_counters`, because the contract's grouping deliberately does not
    #: carry row counts — it groups ids, not rows.
    sourceRows: int = 0
    borough: str | None = None
    nearBorder: float | None = None

    @property
    def id(self) -> str:
        return C.sensor_id(self.counterSerial)

    @property
    def representative(self) -> str:
        """The ONE source sensor id whose in+out series is this counter's number.

        Deterministic and order-independent. The twins carry identical series
        (checked, not assumed: see `twinDivergence`), so which one is chosen
        does not change the published value — only that the value is counted
        once.
        """
        return self.sensorIds[0]

    @property
    def sort_key(self) -> tuple:
        return (self.name, self.counterSerial)


def counters_from_resolved(resolved: list[dict]) -> tuple[list[Counter], list[dict]]:
    """One `Counter` per physical counter, from the records `resolve_counter_identity` returned.

    This is a SHAPE adapter and nothing else: the grouping itself — serial pass,
    then the site pass that folds a counter replaced in the field — is
    `_common.resolve_counter_identity`'s job, and it is not reimplemented here.
    It used to be. A local second copy of the site pass is precisely how the
    contract and its consumer drift apart: the contract grew a `counterSerial`
    and `lat`/`lon` merge that this file's copy did not have, and the two
    disagreed about Willis Ave. One definition, called once.

    The contract records the losers in `counterSerialAliases` and keeps the
    lexicographically greatest serial as canonical, so this only has to read
    them back. The canonical serial is what the published `id` is hashed from,
    so it has to be the same choice the contract made, not a local one.
    """
    counters: list[Counter] = []
    merges: list[dict] = []
    for group in resolved:
        serial = group["counterSerial"]
        aliases = [serial, *group.get("counterSerialAliases", [])]
        counters.append(
            Counter(
                counterSerial=serial,
                sensorIds=sorted(group["sensorIds"]),
                name=group["name"],
                lat=group["lat"],
                lon=group["lon"],
                granularity=group["granularity"],
                directional=bool(group["directional"]),
                serialAliases=sorted(aliases),
            )
        )
        if group.get("counterSerialAliases"):
            merges.append(
                {
                    "name": group["name"],
                    "publishedSerial": serial,
                    "aliases": sorted(group["counterSerialAliases"]),
                    "sensorIds": sorted(group["sensorIds"]),
                    "reason": (
                        "one physical counter published under two counters_serial values; "
                        "collapsed to one feature so its counts are not published twice"
                    ),
                }
            )
    counters.sort(key=lambda counter: counter.sort_key)
    return counters, merges


def build_counters(sensor_rows: Iterable[dict], counters: collections.Counter) -> list[Counter]:
    """Pedestrian-capable physical counters, with coordinates and a borough.

    Bike-only counters are counted and dropped: they are not pedestrian
    coverage, and publishing them would put 33 more points on a map whose whole
    claim is "where we actually measure people on foot".
    """
    rows = list(sensor_rows)
    ped = [row for row in rows if C.is_pedestrian_capable(row)]
    counters["pedestrianSourceRows"] = len(ped)
    counters["nonPedestrianSourceRows"] = len(rows) - len(ped)

    resolved = C.resolve_counter_identity(ped)
    for group in resolved:
        if "pedestrian" not in group["modes"]:
            counters["nonPedestrianResolved"] += 1
    resolved = [group for group in resolved if "pedestrian" in group["modes"]]

    built, merges = counters_from_resolved(resolved)
    for merge in merges:
        counters["multiSerialCounters"] += 1

    rows_per_id: collections.Counter = collections.Counter()
    for row in ped:
        source_id = C.normalise_text(row.get("id"))
        if source_id is not None:
            rows_per_id[source_id] += 1
    for counter in built:
        counter.sourceRows = sum(rows_per_id[value] for value in counter.sensorIds)

    for counter in built:
        if counter.lat is None or counter.lon is None:
            counters["unresolvedCoordinates"] += 1
            continue
        if not C.in_nyc_bbox(counter.lat, counter.lon):
            counters["outsideBbox"] += 1
            continue
        counter.borough = borough_for(counter.lat, counter.lon)
        if counter.borough is None:
            counters["unknownBoroughs"] += 1
        else:
            counter.nearBorder = nearest_edge_degrees(counter.lat, counter.lon)
            if counter.nearBorder is not None and counter.nearBorder < NEAR_BORDER_DEGREES:
                counters["nearBoroughBorder"] += 1
    return [counter for counter in built if counter.borough is not None]


# --------------------------------------------------------------------------- observations

#: A counter's measurement at one timestamp. `None` means the interval is not
#: fully observed — an absent count is not a zero count — and it is excluded
#: from baselines rather than counted as silence.
Observation = dict[str, Any]


def aggregate_counts(
    rows: Iterable[dict],
    index: dict[str, Counter],
    counters: collections.Counter,
) -> tuple[dict[str, dict[datetime, Observation]], list[dict]]:
    """Raw count rows -> one in+out total per (counter, timestamp).

    The twin collapse has ALREADY happened: `index` maps each source sensor id
    to the physical counter it belongs to, and only the counter's
    `representative` id contributes a value. Rows from the other twin are
    counted (so a divergence is visible) and then dropped.
    """
    by_serial = {counter.counterSerial: counter for counter in _counters_of(index)}
    observations: dict[str, dict[datetime, Observation]] = {
        serial: {} for serial in sorted(by_serial)
    }
    rejections: list[dict] = []
    twin_values: dict[tuple[str, datetime, str], int] = {}

    for row in rows:
        source_id = C.normalise_text(row.get("sensor_id"))
        counter = index.get(source_id or "")
        if counter is None:
            counters["unknownSensorIds"] += 1
            rejections.append(
                {
                    "sensorId": source_id,
                    "timestamp": row.get("timestamp"),
                    "reason": (
                        "unknown_sensor_id: no pedestrian counter in 6up2-gnw8 claims this "
                        "sensor_id, so this row has nowhere to go"
                    ),
                }
            )
            continue
        travel_mode = (C.normalise_text(row.get("travelmode")) or "").lower()
        if travel_mode != "pedestrian":
            counters["nonPedestrianRows"] += 1
            rejections.append(
                {
                    "sensorId": source_id,
                    "timestamp": row.get("timestamp"),
                    "reason": f"unexpected_travel_mode: {travel_mode!r} in a pedestrian fetch",
                }
            )
            continue
        direction = (C.normalise_text(row.get("direction")) or "").lower()
        if direction not in C.DIRECTIONS:
            counters["otherDirectionRows"] += 1
        elif direction == "in":
            counters["inRows"] += 1
        else:
            counters["outRows"] += 1
        moment = C.parse_source_timestamp(row.get("timestamp"))
        if moment is None:
            counters["unparseableTimestamps"] += 1
            rejections.append(
                {
                    "sensorId": source_id,
                    "timestamp": row.get("timestamp"),
                    "reason": f"unparseable_timestamp: {row.get('timestamp')!r}",
                }
            )
            continue
        value = C.parse_count(row.get("counts"))
        if value is None:
            counters["nullCounts"] += 1

        if source_id != counter.representative:
            counters["twinRowsCollapsed"] += 1
            if value is not None:
                twin_values.setdefault((counter.counterSerial, moment, direction), value)
            continue

        bucket = observations[counter.counterSerial].setdefault(
            moment, {"directions": {}, "total": None, "required": counter.directional}
        )
        bucket["directions"][direction] = value

    for series in observations.values():
        for bucket in series.values():
            directions = bucket["directions"]
            if not directions:
                continue
            if any(value is None for value in directions.values()):
                # An absent count is not a zero count.
                counters["incompleteIntervals"] += 1
                bucket["total"] = None
                continue
            if bucket["required"] and not set(C.DIRECTIONS) <= set(directions):
                # A half-observed interval is not a total either. A counter the
                # source splits into in+out flows reported only `in` has measured
                # one direction of a sidewalk, and publishing that as the
                # interval's count would understate it by however much the other
                # direction carried — silently, and in the quiet direction.
                counters["incompleteIntervals"] += 1
                bucket["total"] = None
                continue
            bucket["total"] = sum(directions.values())
            counters["observedIntervals"] += 1

    for (serial, moment, direction), twin_value in sorted(
        twin_values.items(), key=lambda item: (item[0][0], item[0][1], item[0][2])
    ):
        primary = observations[serial].get(moment, {}).get("directions", {}).get(direction)
        if primary is not None and primary != twin_value:
            counters["twinDivergence"] += 1
            if counters["twinDivergence"] <= 20:
                rejections.append(
                    {
                        "sensorId": by_serial[serial].representative,
                        "timestamp": C.iso_utc(moment),
                        "reason": (
                            f"twin_divergence: the twin sensor id reports {twin_value} where the "
                            f"representative reports {primary} for direction={direction}"
                        ),
                    }
                )
    return observations, rejections


def _counters_of(index: dict[str, Counter]) -> list[Counter]:
    return sorted(
        {id(counter): counter for counter in index.values()}.values(),
        key=lambda counter: counter.sort_key,
    )


def index_by_sensor_id(counters: Iterable[Counter]) -> dict[str, Counter]:
    index: dict[str, Counter] = {}
    for counter in counters:
        for source_id in counter.sensorIds:
            if source_id in index:
                raise C.DataError(
                    f"source sensor_id {source_id!r} resolves to two counters "
                    f"({index[source_id].counterSerial} and {counter.counterSerial}); "
                    "refusing to guess which one owns the counts"
                )
            index[source_id] = counter
    return index


# --------------------------------------------------------------------------- baseline


def baseline_key(moment: datetime) -> tuple[str, str]:
    return C.day_key(moment), C.time_bucket(moment)


@dataclass
class Baseline:
    samples: int
    median: int | None
    p25: float | None
    p75: float | None
    p90: float | None
    zeroSamples: int
    distinct: int

    @property
    def available(self) -> bool:
        return self.samples >= C.MIN_SAMPLES and self.median is not None

    def as_dict(self) -> dict:
        return {
            "samples": self.samples,
            "distinctValues": self.distinct,
            "zeroSamples": self.zeroSamples,
            "median": self.median,
            "p25": self.p25,
            "p75": self.p75,
            "p90": self.p90,
        }


def history_for(
    series: dict[datetime, Observation],
    key: tuple[str, str],
    *,
    exclude: datetime | None = None,
) -> list[int]:
    """The sums behind a baseline: same weekday, same 15-minute bucket, other days.

    The current observation is excluded from its own baseline. Including it
    would put the point being measured inside the distribution it is scored
    against, which flatters every sensor by one sample.
    """
    values: list[int] = []
    for moment, bucket in series.items():
        if moment == exclude:
            continue
        if baseline_key(moment) != key:
            continue
        total = bucket.get("total")
        if total is None:
            continue
        values.append(total)
    return sorted(values)


def build_baseline(values: list[int]) -> Baseline:
    if not values:
        return Baseline(0, None, None, None, None, 0, 0)
    statistics = {
        name: C.percentile_of(values, fraction) for name, fraction in BASELINE_STATISTICS
    }
    median = statistics["p50"]
    return Baseline(
        samples=len(values),
        median=None if median is None else round_half_up(median),
        p25=statistics["p25"],
        p75=statistics["p75"],
        p90=statistics["p90"],
        zeroSamples=sum(1 for value in values if value == 0),
        distinct=len(set(values)),
    )


# --------------------------------------------------------------------------- extent


def extent_lookup(extent: Iterable[dict]) -> dict[str, dict]:
    """`sensorId -> {firstObservation, lastObservation}` from the fetch meta.

    A counter that stopped reporting has no rows in a recent window, so the
    window alone cannot say WHEN it stopped. The group-by in fetch_counts can,
    in eight rows, which is why that probe exists.
    """
    lookup: dict[str, dict] = {}
    for row in extent or []:
        source_id = C.normalise_text(row.get("sensor_id"))
        if source_id is None:
            continue
        lookup[source_id] = {
            "rows": C.parse_count(row.get("rows")),
            "sumCounts": C.parse_count(row.get("sumCounts")),
            "first": C.parse_source_timestamp(row.get("firstObservation")),
            "last": C.parse_source_timestamp(row.get("lastObservation")),
        }
    return lookup


# --------------------------------------------------------------------------- build


@dataclass
class Outcome:
    features: list[dict]
    latest: dict
    report: dict

    def geojson(self) -> dict:
        return {"type": "FeatureCollection", "features": self.features}


def _feature(counter: Counter, properties: dict) -> dict:
    return {
        "type": "Feature",
        "id": counter.id,
        "geometry": {
            "type": "Point",
            "coordinates": [counter.lon, counter.lat],
        },
        "properties": properties,
    }


def build(
    sensor_rows: list[dict],
    count_rows: list[dict] | None = None,
    *,
    now: Any = None,
    extent: list[dict] | None = None,
    baseline_window_days: int | None = None,
    generated_at: str | None = None,
) -> Outcome:
    moment_now = parse_now(now)
    generated_at = generated_at or C.iso_utc(moment_now)
    counters_dict: collections.Counter = collections.Counter({key: 0 for key in PIPELINE_KEYS})
    all_counters = build_counters(sensor_rows, counters_dict)
    index = index_by_sensor_id(all_counters)
    observations, count_rejections = aggregate_counts(count_rows or [], index, counters_dict)

    extent_by_id = extent_lookup(extent)
    features: list[dict] = []
    detail: list[dict] = []
    activity_counts: collections.Counter = collections.Counter()
    staleness_counts: collections.Counter = collections.Counter()
    sample_sizes: list[int] = []
    suppressed = 0

    for counter in all_counters:
        series = observations.get(counter.counterSerial, {})
        observed_at = max(series) if series else None
        observation = series.get(observed_at) if observed_at else None
        count = observation.get("total") if observation else None

        window_first = min(series) if series else None
        window_last = window_first if observed_at is None else observed_at
        first_observation, first_source = _extent_edge(counter, extent_by_id, "first", window_first)
        last_observation, last_source = _extent_edge(counter, extent_by_id, "last", window_last)

        # Freshness comes from the newest observation that is KNOWN to exist,
        # not the newest one inside the window. A counter that stopped in June
        # has no rows in a 56-day window, and scoring freshness from the window
        # would publish it as `unavailable` — "we have never heard of it" —
        # which loses the only fact a reader needs about a dead counter.
        staleness = C.staleness_for(last_observation, moment_now)

        # A fault is a second, independent answer to "is this counter working?".
        # Recency above says a counter that emitted 192 rows of zeroes an hour
        # ago is `fresh`, and `active` is derived from staleness, so without this
        # a dead counter is published as the most live thing on the map. The
        # gate only opens on a RUN of days, so it needs a real run to close —
        # see FAULT_ZERO_DAYS in the contract for the measured separation.
        zero_run = C.fault_run_days(
            (moment, bucket.get("total")) for moment, bucket in series.items()
        )
        if staleness == "fresh" and zero_run >= C.FAULT_ZERO_DAYS:
            staleness = "faulted"
            counters_dict["faultedCounters"] += 1
        counters_dict["longestZeroDayRun"] = max(
            counters_dict["longestZeroDayRun"], zero_run
        )

        key = baseline_key(observed_at) if observed_at is not None else ("", "")
        values = history_for(series, key, exclude=observed_at) if observed_at else []
        baseline = build_baseline(values)
        sample_sizes.append(baseline.samples)

        expected = percentile = ratio = None
        activity = "unavailable"
        if staleness in ("offline", "unavailable") or count is None:
            # A dead counter publishes no number at all. A stale number on a
            # dead counter is the most confident-looking lie this feature can
            # tell, so the whole numeric block goes null, not just the freshness.
            # `observedAt` goes with it: it is documented as the instant `count`
            # came from, and there is no such instant. `lastObservation` still
            # says when the counter last spoke, which is the fact a reader wants.
            if staleness in ("offline", "unavailable"):
                suppressed += 1
                counters_dict["suppressedOfflineBaselines"] += 1
            count = None
            observed_at = None
        else:
            expected = baseline.median if baseline.available else None
            # The rank needs no division, so it is published even when the
            # median is 0 — a reading above an all-zero history really is at the
            # top of that history. What is NOT published is a level derived from
            # it: `activity_for` returns `quiet` for 0-in-0 and `unavailable`
            # for anything above it, because every level on the ladder means
            # "relative to the foot traffic this bucket normally carries" and a
            # bucket whose median is zero carries none. See the ACTIVITY_BUCKETS
            # note in _common.py for the measured distribution that forces this.
            #
            # `ratio` does divide, so 0/0 is published as null rather than as
            # 0, which would read as "a third of typical".
            if baseline.available:
                rank = C.percentile_rank(count, values)
                percentile = None if rank is None else round_half_up(rank)
                activity = C.activity_for(rank, expected=expected, count=count)
            if expected is None:
                counters_dict["insufficientBaselineSamples"] += 1
            elif expected == 0:
                counters_dict["zeroMedianIntervals"] += 1
                if count > 0:
                    # Real traffic where the baseline says there is none. A level
                    # is not available for it, and the count of these is the
                    # number to watch: a rising count here means the counters
                    # have started reporting from a period, not that the map got
                    # busier.
                    counters_dict["aboveZeroReadingInZeroBaseline"] += 1
            if expected:
                ratio = round(count / expected, 3)

        properties = {
            "id": counter.id,
            "name": counter.name,
            "counterSerial": counter.counterSerial,
            "sensorIds": counter.sensorIds,
            "borough": counter.borough or "",
            "granularity": counter.granularity or "",
            "directional": counter.directional,
            "firstObservation": C.iso_utc(first_observation) if first_observation else None,
            "lastObservation": C.iso_utc(last_observation) if last_observation else None,
            "active": staleness == "fresh",
            "staleness": staleness,
            "activity": activity,
            "count": count,
            "expected": expected,
            "percentile": percentile,
            "ratio": ratio,
            "observationCount": baseline.samples,
            "observedAt": C.iso_utc(observed_at) if observed_at else None,
        }
        if tuple(properties) != C.SENSOR_PROPERTY_ORDER:
            raise C.DataError(
                "SENSOR_PROPERTY_ORDER drifted from the properties this build emitted; "
                "the published schema and src/types/walk.ts must change together"
            )
        features.append(_feature(counter, properties))
        activity_counts[activity] += 1
        staleness_counts[staleness] += 1

        detail.append(
            {
                "id": counter.id,
                "name": counter.name,
                "borough": counter.borough,
                "counterSerial": counter.counterSerial,
                "counterSerialAliases": counter.serialAliases[:-1],
                "sensorIds": counter.sensorIds,
                "representativeSensorId": counter.representative,
                "twinCount": len(counter.sensorIds),
                "sourceRows": counter.sourceRows,
                "nearBoroughBorder": counter.nearBorder,
                "baselineKey": f"{key[0]} {key[1]}" if observed_at else None,
                "baseline": baseline.as_dict(),
                "suppressedBecauseOffline": staleness in ("offline", "unavailable"),
                "windowFirst": C.iso_utc(window_first) if window_first else None,
                "windowLast": C.iso_utc(window_last) if window_last else None,
                "firstObservationSource": first_source,
                "lastObservationSource": last_source,
                "count": count,
                "expected": expected,
                "percentile": percentile,
                "ratio": ratio,
                "activity": activity,
                "staleness": staleness,
            }
        )

    features.sort(key=lambda feature: feature["id"])
    detail.sort(key=lambda item: item["id"])
    digest = C.content_hash(features)

    latest = {
        # No `generatedAt` here on purpose. A timestamp inside a published
        # artifact makes every re-run rewrite it, and "did the data change?"
        # stops being answerable; the build time lives in the report and in
        # metadata.json, and `latestObservation` is the field a reader actually
        # needs. Same reason the eat pipeline keeps generatedAt out of
        # cafes.geojson.
        "latestObservation": max(
            (feature["properties"]["lastObservation"] for feature in features if feature["properties"]["lastObservation"]),
            default=None,
        ),
        "contentHash": digest,
        "sensors": [
            {
                "id": feature["properties"]["id"],
                "name": feature["properties"]["name"],
                "borough": feature["properties"]["borough"],
                "active": feature["properties"]["active"],
                "staleness": feature["properties"]["staleness"],
                "activity": feature["properties"]["activity"],
                "count": feature["properties"]["count"],
                "expected": feature["properties"]["expected"],
                "percentile": feature["properties"]["percentile"],
                "ratio": feature["properties"]["ratio"],
                "observationCount": feature["properties"]["observationCount"],
                "observedAt": feature["properties"]["observedAt"],
            }
            for feature in features
        ],
    }

    usable = [size for size in sample_sizes if size > 0]
    report = {
        "sensors": {
            "source": {
                "sensorsDatasetId": C.SENSORS_DATASET_ID,
                "sensorsDataset": C.SENSORS_NAME,
                "countsDatasetId": C.COUNTS_DATASET_ID,
                "countsDataset": C.COUNTS_NAME,
            },
            "generatedAt": generated_at,
            "contentHash": digest,
            "sourceRows": len(sensor_rows),
            "countRows": len(count_rows or []),
            "publishedSensors": len(features),
            "publishedSensorIds": [feature["properties"]["id"] for feature in features],
            "baseline": {
                "keyedOn": BASELINE_KEYED_ON,
                "statistic": "median",
                "windowDays": baseline_window_days,
                "minSamples": C.MIN_SAMPLES,
                "sampleSizes": sorted(usable),
                "medianSampleSize": round_half_up(sum(usable) / len(usable)) if usable else 0,
                "minSampleSize": min(usable) if usable else 0,
                "maxSampleSize": max(usable) if usable else 0,
                "suppressedOfflineBaselines": suppressed,
            },
            "activity": {key: activity_counts.get(key, 0) for key in C.ACTIVITY_BUCKETS},
            "staleness": {key: staleness_counts.get(key, 0) for key in C.STALENESS_STATES},
            "boroughDerivation": BOROUGH_DERIVATION,
            "sensors": detail,
            "pipeline": {
                key: int(counters_dict.get(key, 0)) for key in sorted(set(PIPELINE_KEYS) | set(counters_dict))
            },
            "rejections": sorted(
                count_rejections, key=lambda item: (item["reason"].split(":")[0], str(item.get("sensorId")))
            ),
        }
    }
    return Outcome(features=features, latest=latest, report=report)


def _extent_edge(
    counter: Counter,
    extent_by_id: dict[str, dict],
    edge: str,
    fallback: datetime | None,
) -> tuple[datetime | None, str]:
    """The all-time first/last observation for a counter, from either source.

    The window knows what we fetched; the group-by knows what exists. Take
    whichever reaches further, and record which one it was — a dead counter's
    last observation is the single fact that explains why it publishes nothing.
    """
    candidates: list[tuple[datetime, str]] = []
    for source_id in counter.sensorIds:
        found = extent_by_id.get(source_id, {}).get(edge)
        if found is not None:
            candidates.append((found, "counts-extent"))
    if fallback is not None:
        candidates.append((fallback, "window"))
    if not candidates:
        return None, "none"
    chosen = min(candidates) if edge == "first" else max(candidates)
    return chosen


# --------------------------------------------------------------------------- artifacts


def write(
    outcome: Outcome,
    *,
    geojson_path: Path | None = None,
    latest_path: Path | None = None,
) -> None:
    C.write_json_file(geojson_path or C.SENSOR_GEOJSON_PATH, outcome.geojson())
    C.write_json_file(latest_path or C.LATEST_PATH, outcome.latest)


def verify_snapshot(path: Path, meta_path: Path) -> dict:
    """Refuse to build from a raw snapshot that no longer matches its fetch meta.

    A snapshot that has drifted from the hash recorded at fetch time is either
    half-written or hand-edited, and either way a baseline computed from it
    would be a baseline from data the city never published.
    """
    meta = C.read_fetch_meta(meta_path)
    if not meta or not meta.get("contentHash") or not path.exists():
        return meta or {}
    expected = meta["contentHash"]
    actual = C.sha256_hex(C.canonical_json(C.load_raw_rows(path)).encode("utf-8"))
    if actual != expected:
        raise C.DataError(
            f"{path} does not match {meta_path.name} "
            f"(content hash {actual} != {expected}); re-run the matching fetch script"
        )
    return meta


def format_summary(outcome: Outcome) -> str:
    half = outcome.report["sensors"]
    baseline = half["baseline"]
    lines = [
        f"  sensor rows            {half['sourceRows']} ({half['pipeline'].get('pedestrianSourceRows', 0)} pedestrian-capable)",
        f"  count rows in window   {half['countRows']}",
        f"  published counters     {half['publishedSensors']}",
        f"  twin rows collapsed    {half['pipeline'].get('twinRowsCollapsed', 0)}"
        f"  (twin divergence {half['pipeline'].get('twinDivergence', 0)})",
        f"  multi-serial counters  {half['pipeline'].get('multiSerialCounters', 0)}",
        f"  baseline              {baseline['keyedOn']}, {baseline['statistic']},"
        f" min {baseline['minSamples']} samples",
        f"  samples per bucket     min {baseline['minSampleSize']},"
        f" median {baseline['medianSampleSize']}, max {baseline['maxSampleSize']}",
        f"  activity              {C.compact_json(half['activity'])}",
        f"  staleness             {C.compact_json(half['staleness'])}",
        f"  content hash           {half['contentHash']}",
    ]
    if half["pipeline"].get("nearBoroughBorder"):
        lines.append(
            f"  ! {half['pipeline']['nearBoroughBorder']} counter(s) within "
            f"{NEAR_BORDER_DEGREES} deg of a borough rectangle edge — the borough label is a"
            " coarse derivation from lat/lon, not source data"
        )
    for item in half["sensors"]:
        lines.append(
            f"    {item['name']:22} {item['staleness']:11} {item['activity']:11}"
            f" count={item['count']} expected={item['expected']}"
            f" n={item['baseline']['samples']} twins={item['twinCount']}"
        )
    if half["rejections"]:
        lines.append(f"  rejections             {len(half['rejections'])}")
        for item in half["rejections"][:20]:
            lines.append(f"    - {item['reason']}  [{item.get('sensorId')} / {item.get('timestamp')}]")
    return "\n".join(lines)


def run(
    *,
    raw_sensors: Path | None = None,
    raw_counts: Path | None = None,
    sensors_meta: Path | None = None,
    counts_meta: Path | None = None,
    now: Any = None,
    out_dir: Path | None = None,
    report_path: Path | None = None,
    quiet: bool = False,
    write_files: bool = True,
) -> Outcome:
    sensors_path = raw_sensors or C.SENSORS_RAW_PATH
    counts_path = raw_counts or C.COUNTS_RAW_PATH
    sensors_meta_path = sensors_meta or C.SENSORS_META_PATH
    counts_meta_path = counts_meta or C.COUNTS_META_PATH
    verify_snapshot(sensors_path, sensors_meta_path)
    sensor_rows = C.load_raw_rows(sensors_path)
    count_rows = C.load_raw_rows(counts_path) if counts_path.exists() else []
    verify_snapshot(counts_path, counts_meta_path)
    counts_fetch_meta = C.read_fetch_meta(counts_meta_path) or {}

    outcome = build(
        sensor_rows,
        count_rows,
        now=now,
        extent=counts_fetch_meta.get("sensorExtent"),
        baseline_window_days=counts_fetch_meta.get("baselineWindowDays"),
    )

    geojson_path = latest_path = None
    if out_dir is not None:
        out_dir.mkdir(parents=True, exist_ok=True)
        geojson_path = out_dir / "sensors.geojson"
        latest_path = out_dir / "latest.json"
    if write_files:
        write(outcome, geojson_path=geojson_path, latest_path=latest_path)
        if report_path is not None:
            C.write_json_file(report_path, outcome.report)
    if not quiet:
        print(format_summary(outcome))
    return outcome


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--raw-sensors", type=Path, default=None, help="sensor snapshot to read")
    parser.add_argument("--raw-counts", type=Path, default=None, help="count snapshot to read")
    parser.add_argument("--sensors-meta", type=Path, default=None, help="sensor fetch-meta to read")
    parser.add_argument("--counts-meta", type=Path, default=None, help="counts fetch-meta to read")
    parser.add_argument("--now", default=None, help="pin the clock (ISO-8601 UTC) for a reproducible build")
    parser.add_argument("--out-dir", type=Path, default=None, help="write sensors.geojson/latest.json here")
    parser.add_argument("--report", type=Path, default=None, help="write this half's report here")
    parser.add_argument("--quiet", action="store_true", help="only report failures")
    args = parser.parse_args(argv)
    try:
        run(
            raw_sensors=args.raw_sensors,
            raw_counts=args.raw_counts,
            sensors_meta=args.sensors_meta,
            counts_meta=args.counts_meta,
            now=args.now,
            out_dir=args.out_dir,
            report_path=args.report,
            quiet=args.quiet,
        )
    except C.PipelineError as exc:
        print(f"build_sensors: {exc}", file=sys.stderr)
        return 1
    except KeyboardInterrupt:  # pragma: no cover
        print("build_sensors: interrupted", file=sys.stderr)
        return 130
    targets = [args.out_dir / "sensors.geojson", args.out_dir / "latest.json"] if args.out_dir else [
        C.SENSOR_GEOJSON_PATH,
        C.LATEST_PATH,
    ]
    for path in targets:
        print(f"  wrote {C.display_path(path)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
