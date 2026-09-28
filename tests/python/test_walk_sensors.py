"""The sensor pipeline: twin collapse, baselines, staleness, determinism, validation.

No network. Every fixture is an inline dataset shaped like the two real sources
— 6up2-gnw8 (67 rows, 42 distinct `id`) and ct66-47at (pedestrian rows only) —
and the shapes used here are the shapes measured on 2026-09-28:

  * one physical counter published under TWO `sensor_id` values, one row tagged
    `bike, pedestrian` and one tagged `pedestrian`, sharing a `counters_serial`,
    coordinates and a byte-identical count series;
  * each of those sensor ids split into an `in` and an `out` flow with distinct
    `flowid`s;
  * Willis Ave publishing one series under two serials (a 2018 and a 2021 unit).
"""

from __future__ import annotations

import copy
import importlib.util
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
WALK_DIR = REPO_ROOT / "scripts" / "walk"
if str(WALK_DIR) not in sys.path:
    sys.path.insert(0, str(WALK_DIR))
if "walk_common" not in sys.modules:
    _spec = importlib.util.spec_from_file_location("walk_common", WALK_DIR / "_common.py")
    _module = importlib.util.module_from_spec(_spec)
    sys.modules["walk_common"] = _module
    _spec.loader.exec_module(_module)

import walk_common as W  # noqa: E402
import build_sensors  # noqa: E402
import fetch_counts  # noqa: E402
import fetch_sensors  # noqa: E402
import validate_walk  # noqa: E402

UTC = timezone.utc
EST = timezone(W.SOURCE_UTC_OFFSET)

#: A fixed instant to build against, so `staleness` is a fact and not a race.
#: The Monday bucket below is 06:00 UTC, so this puts the fixture three hours
#: old: `fresh`.
NOW = "2026-09-28T09:00:00Z"

#: The bucket every fixture reads, on a Monday (2026-09-28 is a Monday).
BUCKET = "01:00"
MONDAY = "2026-09-28T01:00:00.000"

SERIAL = "YAH22104563"
SENSOR_A = "300040736"   # tagged "bike, pedestrian"
SENSOR_B = "300043073"   # tagged "pedestrian"
WILLIS_SERIAL_2018 = "YAH18055368"
WILLIS_SERIAL_2021 = "YAH22104565"


# --------------------------------------------------------------------------- fixtures


def sensor_row(**overrides) -> dict:
    """One 6up2-gnw8 row, as Socrata publishes it: every scalar a string."""
    row = {
        "id": SENSOR_A,
        "name": "Concrete Plant Park",
        "lat": "40.827664",
        "lon": "-73.8850099",
        "firstdata": "2024-04-04T13:45:00.000",
        "lastdata": "2026-09-28T01:00:00.000",
        "granularity": "PT15M",
        "travelmodes": "bike, pedestrian",
        "directional": "true",
        "hastimestampeddata": "true",
        "hasweather": "true",
        "counters_id": "1",
        "counters_serial": SERIAL,
        "counters_installationdate": "2024-04-01T00:00:00.000",
    }
    row.update(overrides)
    return row


def twin_rows(**overrides) -> list[dict]:
    """The two 6up2-gnw8 rows for one physical counter, byte-identical but for id/name/modes."""
    return [
        sensor_row(id=SENSOR_A, travelmodes="bike, pedestrian", **overrides),
        sensor_row(
            id=SENSOR_B,
            name="Concrete Plant Park Peds",
            travelmodes="pedestrian",
            **overrides,
        ),
    ]


def count_row(sensor_id: str, direction: str, timestamp: str, counts, **overrides) -> dict:
    """One ct66-47at pedestrian row. `counts` is a number, `None`, or junk."""
    row = {
        "sensor_id": sensor_id,
        "travelmode": "pedestrian",
        "direction": direction,
        "flowid": "353438190" if direction == "in" else "353438191",
        "flowname": f"Concrete Plant Park [Pedestrian {direction.upper()}]",
        "timestamp": timestamp,
        "granularity": "PT15M",
        "counts": "0" if counts is None else str(counts),
        "status": "raw",
    }
    if counts is None:
        row["counts"] = None
    row.update(overrides)
    return row


def twin_count_rows(timestamp: str, total, sensor_ids=(SENSOR_A, SENSOR_B), split=(0.6, 0.4)) -> list[dict]:
    """Both twins, both directions, summing to `total` — the shape the source publishes.

    Every twin carries the SAME two rows, which is what makes the collapse
    detectable: sum all four and you get 2x, sum the representative's two and
    you get the physical count.
    """
    inbound = int(round(total * split[0]))
    outbound = int(round(total * split[1]))
    rows = []
    for sensor_id in sensor_ids:
        rows.append(count_row(sensor_id, "in", timestamp, inbound))
        rows.append(count_row(sensor_id, "out", timestamp, outbound))
    return rows


def weeks_before(timestamp: str, weeks: int) -> str:
    """The same weekday and bucket, `weeks` earlier."""
    moment = W.parse_source_timestamp(timestamp)
    assert moment is not None
    earlier = moment - timedelta(weeks=weeks)
    return earlier.strftime("%Y-%m-%dT%H:%M:%S.000")


def history_weeks(count: int) -> list[str]:
    """`count` prior Mondays on the same bucket, newest first.

    MIN_SAMPLES is 7, so a fixture that wants a baseline needs seven of these.
    A test that wants to be BELOW the gate asks for fewer, and that difference
    is the point of those tests.
    """
    return [weeks_before(MONDAY, weeks) for weeks in range(1, count + 1)]


def history_rows(values, *, total=None) -> list[dict]:
    """`twin_count_rows` for each value against the matching prior week.

    `values` is a list, one per prior week, oldest-last so that
    `history_rows([100, 110, 120])` reads in the same order as a history list.
    """
    weeks = history_weeks(len(values))
    rows: list[dict] = []
    for weeks_ago, value in zip(reversed(weeks), values):
        rows.extend(twin_count_rows(weeks_ago, value if total is None else total))
    return rows


def build(sensor_rows, count_rows, *, now=NOW, extent=None, **kwargs):
    return build_sensors.build(
        list(sensor_rows), list(count_rows), now=now, extent=extent, **kwargs
    )


def properties_of(outcome, name: str = "Concrete Plant Park") -> dict:
    matches = [f for f in outcome.features if f["properties"]["name"] == name]
    assert len(matches) == 1, f"expected one {name!r} feature, got {len(matches)}"
    return matches[0]["properties"]


def sensor_of(outcome, name: str = "Concrete Plant Park") -> dict:
    matches = [s for s in outcome.report["sensors"]["sensors"] if s["name"] == name]
    assert len(matches) == 1
    return matches[0]


# --------------------------------------------------------------------------- one source of truth
#
# The refactor these tests exist for: five scripts and a shared contract used to
# carry THREE private copies of things the contract already owns, plus a fourth
# copy of the site-merge that the contract had grown and the build had not. Each
# copy was a place for the two halves to disagree silently.


@pytest.mark.parametrize(
    "module,names",
    [
        # The HTTP client and its retry policy.
        (fetch_sensors, ("http_get", "http_get_json", "parse_json_body", "_backoff_delay",
                         "BACKOFF_BASE_SECONDS", "BACKOFF_CAP_SECONDS", "sha256_hex", "epoch_to_iso")),
        (fetch_counts, ("http_get", "http_get_json", "parse_json_body", "_backoff_delay",
                        "BACKOFF_BASE_SECONDS", "BACKOFF_CAP_SECONDS", "sha256_hex", "epoch_to_iso")),
        # The offset ceiling.
        (fetch_counts, ("MAX_OFFSET",)),
        # The property-type mapping.
        (validate_walk, ("js_kind",)),
        # The site-merge, which now lives only in the contract's two passes.
        (build_sensors, ("merge_serial_aliases", "sha256_hex")),
    ],
)
def test_nothing_redefines_what_the_contract_owns(module, names):
    """A duplicate is not a style preference here, it is a drift hazard.

    `scripts/walk/_common.py` is the single definition of the retry policy, the
    offset ceiling, the JS property-type mapping and the counter identity
    rules. A second copy in a consumer cannot be caught by reading the
    consumer, and the whole point of extracting them was that the first
    divergence was found by a review rather than by a test.
    """
    for name in names:
        assert not hasattr(module, name), (
            f"{module.__name__} defines its own {name!r}; it must come from _common so the "
            "contract and its consumers cannot drift apart"
        )


def test_the_offset_ceiling_is_the_contracts_and_not_a_local_number():
    assert fetch_counts.C.MAX_SOCRATA_OFFSET == W.MAX_SOCRATA_OFFSET == 43_000
    # Deliberately below Socrata's own 43,043, so a ceiling you can hit is a
    # ceiling that truncates. Asserted because the value is load-bearing for the
    # window budget and is not derivable from the endpoint at run time.
    assert W.MAX_SOCRATA_OFFSET < 43_043


def test_where_bounds_are_written_in_new_york_civil_time():
    """The `$where` fix, which is the bug the timezone correction exposed.

    The `timestamp` column holds civil wall clocks, so Socrata compares the
    literal against a stored wall clock. Converting a bound to a fixed -05:00
    produced a window that started an hour late and ended an hour early in
    summer — silently, because the row COUNT still looked plausible.
    """
    now = datetime(2026, 7, 14, 20, 30, tzinfo=UTC)   # 16:30 EDT
    assert fetch_counts.to_source_iso(now) == "2026-07-14T16:30:00"
    winter = datetime(2026, 1, 14, 20, 30, tzinfo=UTC)  # 15:30 EST
    assert fetch_counts.to_source_iso(winter) == "2026-01-14T15:30:00"
    # `--since` means midnight on that date as a New Yorker reads the clock.
    assert fetch_counts.parse_date_bound("2026-07-14").strftime("%H:%M:%S") == "00:00:00"
    assert fetch_counts.parse_date_bound("2026-07-14").utcoffset() == timedelta(hours=-4)
    assert fetch_counts.parse_date_bound("2026-01-14").utcoffset() == timedelta(hours=-5)
    # And a whole summer window is a whole summer window, not an hour short.
    start = fetch_counts.parse_date_bound("2026-08-03")
    end = fetch_counts.parse_date_bound("2026-08-09")
    where = fetch_counts.where_clause(start, end)
    assert f"timestamp >= '{fetch_counts.to_source_iso(start)}'" in where
    assert "2026-08-03T00:00:00" in where and "2026-08-09T00:00:00" in where


def test_a_watermark_written_in_civil_time_reads_back_as_civil_time():
    """`to_source_iso` and `parse_source_bound` must be inverse.

    The watermark is what an incremental run resumes from, so if the write and
    the read disagreed by an hour every run would re-fetch or skip an hour at
    the boundary — with no error either way.
    """
    for text in ("2026-07-14T16:30:00", "2026-01-14T15:30:00", "2026-11-01T01:30:00"):
        moment = fetch_counts.parse_source_bound(text)
        assert moment is not None
        assert fetch_counts.to_source_iso(moment) == text
        assert moment.utcoffset() == W.parse_source_timestamp(text).utcoffset()


def test_build_sensors_uses_the_contracts_two_pass_identity_not_its_own():
    """Willis Ave, end to end, through the contract's own grouping.

    The build used to carry a private second pass that merged on
    (sensorIds, lat, lon) as an exact tuple. The contract's pass 2 merges on a
    1e-4 degree epsilon as well, which is what makes a counter replaced in the
    field collapse. This asserts the consumer reads the contract's answer —
    including `counterSerialAliases`, which the private copy could not produce
    correctly at all (see the alias-order test below).
    """
    sensors = [
        sensor_row(id=SENSOR_A, name="Willis Ave", counters_serial=WILLIS_SERIAL_2018),
        sensor_row(id=SENSOR_A, name="Willis Ave", counters_serial=WILLIS_SERIAL_2021),
        sensor_row(id=SENSOR_B, name="Willis Ave Peds", travelmodes="pedestrian",
                   counters_serial=WILLIS_SERIAL_2018),
        sensor_row(id=SENSOR_B, name="Willis Ave Peds", travelmodes="pedestrian",
                   counters_serial=WILLIS_SERIAL_2021),
    ]
    detail = sensor_of(build(sensors, twin_count_rows(MONDAY, 250)), "Willis Ave")
    assert detail["counterSerial"] == max(WILLIS_SERIAL_2018, WILLIS_SERIAL_2021)
    assert detail["counterSerialAliases"] == [
        serial for serial in sorted((WILLIS_SERIAL_2018, WILLIS_SERIAL_2021))
        if serial != detail["counterSerial"]
    ]
    # 6up2-gnw8 publishes 4 rows for this one counter: 2 ids x 2 serials.
    assert detail["sourceRows"] == 4


@pytest.mark.parametrize("older_first", [True, False])
def test_the_recorded_serial_alias_does_not_depend_on_row_order(older_first):
    """A published field that changed with input order is a determinism bug.

    The contract's site pass demotes one serial and records it. Which of the two
    it recorded used to depend on which the source happened to list first, so
    `counterSerialAliases` was empty on some row orders and populated on others
    — in a pipeline whose entire determinism argument is that row order cannot
    reach the artifact. The recorded alias is the serial being DEMOTED, so it is
    the same on both orders.
    """
    import itertools

    def rows(order):
        return [
            sensor_row(id=SENSOR_A, name="Willis Ave", counters_serial=serial)
            for serial in order
        ] + [
            sensor_row(id=SENSOR_B, name="Willis Ave Peds", travelmodes="pedestrian",
                       counters_serial=serial)
            for serial in order
        ]

    serials = [WILLIS_SERIAL_2018, WILLIS_SERIAL_2021]
    outcomes = set()
    for permutation in itertools.permutations(serials):
        detail = sensor_of(build(rows(list(permutation)), twin_count_rows(MONDAY, 250)), "Willis Ave")
        outcomes.add((detail["counterSerial"], tuple(detail["counterSerialAliases"])))
    assert len(outcomes) == 1, f"row order reached the published alias: {outcomes}"
    (canonical, aliases), = outcomes
    assert canonical == WILLIS_SERIAL_2021          # lexicographically greatest
    assert aliases == (WILLIS_SERIAL_2018,)


# --------------------------------------------------------------------------- twin collapse


def test_two_sensor_ids_one_serial_publish_one_feature():
    """67 rows, 42 distinct `id`, and 8 pedestrian `sensor_id`s for 4 counters.

    The build must publish 4 features from 8 pedestrian ids, not 8.
    """
    sensors = []
    counts = []
    for index, (serial, a, b, name, lat, lon) in enumerate(
        [
            (SERIAL, "300040736", "300043073", "Concrete Plant Park", "40.827664", "-73.8850099"),
            ("YAH22104564", "300038509", "300043075", "Emmons Ave", "40.5841", "-73.93099"),
            ("YAH22104566", "300038506", "300043077", "High Bridge", "40.84219", "-73.93207"),
        ]
    ):
        pair = [
            sensor_row(id=a, name=name, counters_serial=serial, lat=lat, lon=lon),
            sensor_row(
                id=b,
                name=f"{name} Peds",
                travelmodes="pedestrian",
                counters_serial=serial,
                lat=lat,
                lon=lon,
            ),
        ]
        sensors.extend(pair)
        counts.extend(twin_count_rows(MONDAY, 100 * (index + 1)))

    outcome = build(sensors, counts)
    assert len(outcome.features) == 3
    assert sum(len(f["properties"]["sensorIds"]) for f in outcome.features) == 6
    assert len({f["properties"]["counterSerial"] for f in outcome.features}) == 3


def test_two_counters_at_the_same_coordinates_are_collapsed_as_one_site():
    """The flip side of the site pass, and it is deliberate.

    `_common.resolve_counter_identity` pass 2 folds groups that share a sensor
    id OR sit within 1e-4 degrees, because a counter replaced in the field
    keeps its position. So two distinct serials reported at the same point are
    one physical site, not two, and publishing both would double the volume on
    any aggregate — the same bug as the id twins, with a different trigger.

    This is asserted because it is a real constraint on the data, not an
    accident: two genuinely distinct counters are never 11 m apart.
    """
    sensors = [
        sensor_row(id=SENSOR_A, name="Emmons Ave", counters_serial="YAH22104564"),
        sensor_row(
            id=SENSOR_B,
            name="Emmons Ave Peds",
            travelmodes="pedestrian",
            counters_serial="YAH22104564",
        ),
        sensor_row(id=SENSOR_A, name="Emmons Ave West", counters_serial="YAH99999999"),
    ]
    outcome = build(sensors, twin_count_rows(MONDAY, 100))
    assert len(outcome.features) == 1
    detail = sensor_of(outcome, "Emmons Ave")
    # The canonical serial is the lexicographically greatest, so the published
    # id — which is a hash of that serial — depends on the choice. It is a
    # deterministic choice, not an arbitrary one, and it is recorded.
    assert detail["counterSerial"] == "YAH99999999"
    assert detail["counterSerialAliases"] == ["YAH22104564"]
    assert detail["sensorIds"] == [SENSOR_A, SENSOR_B]
    assert outcome.report["sensors"]["pipeline"]["multiSerialCounters"] == 1


def test_the_twins_are_summed_once_and_the_total_is_not_doubled():
    """The central trap, as a test.

    The source publishes 100 people in this interval. Summing the four raw rows
    (2 sensor ids x 2 directions) gives 200. The published `count` must be 100.
    """
    counts = twin_count_rows(MONDAY, 100) + twin_count_rows(weeks_before(MONDAY, 1), 90)
    outcome = build(twin_rows(), counts)
    properties = properties_of(outcome)

    assert properties["count"] == 100
    # What a sensor_id-keyed aggregation would have published.
    naive = sum(int(row["counts"]) for row in counts if row["timestamp"] == MONDAY)
    assert naive == 200
    assert properties["count"] == naive // 2
    assert properties["count"] != naive
    # And the report accounts for every collapsed row rather than dropping it.
    report = outcome.report["sensors"]
    assert report["pipeline"]["twinRowsCollapsed"] == 4   # 2 timestamps x 2 twins
    assert report["pipeline"]["observedIntervals"] == 2
    # inRows/outRows count RAW rows, twins included: 2 timestamps x 2 twins x 2
    # directions. They are diagnostics, not the published aggregate.
    assert report["pipeline"]["inRows"] == 4
    assert report["pipeline"]["outRows"] == 4
    assert report["pipeline"]["twinDivergence"] == 0


def test_the_collapsed_total_equals_the_representative_alone_not_the_twin_doubled_sum():
    counts = twin_count_rows(MONDAY, 137)
    outcome = build(twin_rows(), counts)
    properties = properties_of(outcome)

    representative = min(SENSOR_A, SENSOR_B)
    per_id = {}
    for row in counts:
        if row["timestamp"] == MONDAY:
            per_id.setdefault(row["sensor_id"], 0)
            per_id[row["sensor_id"]] += int(row["counts"])
    assert len(set(per_id.values())) == 1, "the twins must carry identical series"
    assert sum(per_id.values()) == 274  # 2x
    assert properties["count"] == 137
    assert properties["count"] == per_id[representative]
    assert sensor_of(outcome)["representativeSensorId"] == representative


def test_in_plus_out_is_summed_and_neither_direction_alone():
    counts = [
        count_row(SENSOR_A, "in", MONDAY, 70),
        count_row(SENSOR_A, "out", MONDAY, 30),
        count_row(SENSOR_B, "in", MONDAY, 70),
        count_row(SENSOR_B, "out", MONDAY, 30),
    ]
    outcome = build(twin_rows(), counts)
    assert properties_of(outcome)["count"] == 100
    assert outcome.report["sensors"]["pipeline"]["inRows"] == 2
    assert outcome.report["sensors"]["pipeline"]["outRows"] == 2
    assert outcome.report["sensors"]["pipeline"]["twinRowsCollapsed"] == 2


def test_one_serial_referenced_by_both_rows_collapses_before_aggregation():
    """A `sensor_id` belonging to two serials must never be summed twice."""
    sensors = [
        sensor_row(id=SENSOR_A, counters_serial=SERIAL),
        sensor_row(id=SENSOR_B, travelmodes="pedestrian", counters_serial=SERIAL),
    ]
    outcome = build(sensors, twin_count_rows(MONDAY, 60))
    assert len(outcome.features) == 1
    assert properties_of(outcome)["count"] == 60


def test_one_physical_counter_under_two_serials_publishes_one_feature():
    """Willis Ave: a 2018 unit and a 2021 unit, one series, two serials.

    `resolve_counter_identity` keys on `counters_serial`, so on its own it
    returns two records here — which would publish the same sidewalk twice at
    the same coordinates. The build merges them, keeps one serial, and records
    the other rather than discarding it.
    """
    sensors = [
        sensor_row(id=SENSOR_A, name="Willis Ave", counters_serial=WILLIS_SERIAL_2018),
        sensor_row(id=SENSOR_A, name="Willis Ave", counters_serial=WILLIS_SERIAL_2021),
        sensor_row(
            id=SENSOR_B,
            name="Willis Ave Peds",
            travelmodes="pedestrian",
            counters_serial=WILLIS_SERIAL_2018,
        ),
        sensor_row(
            id=SENSOR_B,
            name="Willis Ave Peds",
            travelmodes="pedestrian",
            counters_serial=WILLIS_SERIAL_2021,
        ),
    ]
    counts = twin_count_rows(MONDAY, 250)
    outcome = build(sensors, counts)

    assert len(outcome.features) == 1
    properties = properties_of(outcome, "Willis Ave")
    assert properties["counterSerial"] in (WILLIS_SERIAL_2018, WILLIS_SERIAL_2021)
    assert properties["count"] == 250
    detail = sensor_of(outcome, "Willis Ave")
    assert detail["counterSerialAliases"] == [
        serial for serial in sorted((WILLIS_SERIAL_2018, WILLIS_SERIAL_2021))
        if serial != properties["counterSerial"]
    ]
    assert outcome.report["sensors"]["pipeline"]["multiSerialCounters"] == 1
    # The published id is a function of the published serial alone, and the
    # two serial choices give two DIFFERENT ids — so this is a real choice.
    assert properties["id"] == W.sensor_id(properties["counterSerial"])


def test_diverging_twins_are_recorded_not_silently_averaged():
    """If the twins ever disagree, the assumption the whole model rests on is
    broken. One of them is wrong and nothing says which, so the build publishes
    the representative and the pipeline reports every disagreement."""
    counts = [
        count_row(SENSOR_A, "in", MONDAY, 70),
        count_row(SENSOR_A, "out", MONDAY, 30),
        count_row(SENSOR_B, "in", MONDAY, 55),
        count_row(SENSOR_B, "out", MONDAY, 30),
    ]
    outcome = build(twin_rows(), counts)
    assert outcome.report["sensors"]["pipeline"]["twinDivergence"] == 1
    reasons = [item["reason"].split(":")[0] for item in outcome.report["sensors"]["rejections"]]
    assert "twin_divergence" in reasons
    assert properties_of(outcome)["count"] == 100


# --------------------------------------------------------------------------- baseline


def test_the_specified_example_produces_the_specified_numbers():
    """history [100,110,120,130,140,150,160] on this weekday+bucket, reading 135.

    By hand:
      median      4th of 7                          -> 130
      percentile  4 of 7 history values below 135   -> 4/7 = 57.1 -> 57
      ratio       135 / 130                          -> 1.038
      activity    57 is in [25, 75)                  -> "typical"
    """
    history = [100, 110, 120, 130, 140, 150, 160]
    counts = twin_count_rows(MONDAY, 135) + history_rows(history)

    outcome = build(twin_rows(), counts)
    properties = properties_of(outcome)
    assert properties["observationCount"] == 7
    assert properties["expected"] == 130
    assert properties["percentile"] == 57
    assert properties["ratio"] == round(135 / 130, 3)
    assert properties["activity"] == "typical"
    assert properties["count"] == 135
    # The percentiles that justify the ladder, computed and reported.
    baseline = sensor_of(outcome)["baseline"]
    assert baseline["median"] == 130
    assert baseline["p25"] == 115
    assert baseline["p75"] == 145
    assert baseline["p90"] == 154.0


@pytest.mark.parametrize(
    "value,expected_percentile,expected_activity",
    [
        # bottom of the set: 0 of 7 below -> 0 -> "quiet"
        (99, 0, "quiet"),
        # the 25th-percentile value, untied: 2 below -> 2/7 = 28.6 -> 29 -> "typical"
        (115, 29, "typical"),
        # one above it: the same 2 below, so the same rank. A rank is a rank.
        (116, 29, "typical"),
        # exactly the median: 3 below, 1 equal -> (3 + 0.5)/7 = 50 -> "typical"
        (130, 50, "typical"),
        # one above the median: 4 below, 0 equal -> 4/7 = 57.1 -> 57 -> "typical"
        (131, 57, "typical"),
        # the 75th-percentile value, untied: 5 below -> 5/7 = 71.4 -> 71 -> "typical"
        (145, 71, "typical"),
        # the 90th-percentile value, untied: 6 below -> 6/7 = 85.7 -> 86 -> "busy"
        (155, 86, "busy"),
        # tied at the top: 6 below, 1 equal -> (6 + 0.5)/7 = 92.9 -> 93 -> "veryBusy"
        (160, 93, "veryBusy"),
        # top of the set: 7 below -> 100 -> "veryBusy"
        (161, 100, "veryBusy"),
    ],
)
def test_the_activity_ladder_against_the_same_seven_sample_history(
    value, expected_percentile, expected_activity
):
    counts = twin_count_rows(MONDAY, value) + history_rows([100, 110, 120, 130, 140, 150, 160])
    properties = properties_of(build(twin_rows(), counts))
    assert properties["percentile"] == expected_percentile
    assert properties["activity"] == expected_activity


def test_below_min_samples_the_baseline_is_unavailable_not_a_guess():
    """Six observations is not a median worth publishing. `unavailable` is a
    state, not a level of activity: the map must say "we cannot tell", not
    "quiet"."""
    counts = twin_count_rows(MONDAY, 500) + history_rows([10, 20, 30, 40, 50, 60])

    properties = properties_of(build(twin_rows(), counts))
    assert properties["observationCount"] == 6
    assert W.MIN_SAMPLES == 7
    assert 6 < W.MIN_SAMPLES
    assert properties["expected"] is None
    assert properties["percentile"] is None
    assert properties["ratio"] is None
    assert properties["activity"] == "unavailable"
    # The reading itself is still published: freshness and the baseline are
    # different questions.
    assert properties["count"] == 500
    assert properties["staleness"] == "fresh"


def test_exactly_min_samples_is_enough():
    assert W.MIN_SAMPLES == 7
    counts = twin_count_rows(MONDAY, 135) + history_rows([100, 110, 120, 130, 140, 150, 160])
    properties = properties_of(build(twin_rows(), counts))
    assert properties["observationCount"] == W.MIN_SAMPLES
    assert properties["expected"] == 130
    assert properties["percentile"] == 57
    assert properties["activity"] == "typical"


def test_min_samples_is_seven_because_very_busy_is_unreachable_below_it():
    """The arithmetic that fixes MIN_SAMPLES at 7, asserted so it cannot drift.

    `percentile_rank` credits half the ties, so the highest percentile any
    observation can reach is `100 - 50/n`. At n=4 that is 87.5, and at n=6 it
    is 91.7 — but 6 was the *accidental* pass and 7 is the observed floor of
    the 8-week window: 1,241 of 1,344 (weekday x 15-minute) keys get 8 samples
    and 103 get exactly 7, where the window boundary lands mid-day. Gating at 7
    therefore costs a healthy refresh nothing.

    The failure this prevents is not a small number, it is a missing label:
    `veryBusy` is the claim a reader is most likely to act on, and below the
    gate it is structurally unreachable while the ladder still looks complete.
    """
    # The maximum attainable rank is a reading that ties with the single
    # largest sample: n-1 strictly below, 1 equal -> (n - 0.5)/n = 100 - 50/n.
    def best_attainable(samples: int) -> float:
        return W.percentile_rank(2, [1] * (samples - 1) + [2])

    for samples in range(2, 9):
        assert best_attainable(samples) == pytest.approx(100 - 50 / samples)
    # At 4 the top of the ladder is out of reach; at 5 and above it is in it.
    assert best_attainable(4) == 87.5
    for samples in range(2, 9):
        assert (90 <= best_attainable(samples)) == (samples >= 5)


def test_a_missing_observation_is_excluded_from_the_baseline_not_counted_as_zero():
    """Nine intervals, two of them half-observed -> seven usable, median 140.

    If the two absent intervals became zeros the median would be 130, and the
    published `expected` would drop by 7%. The difference between "quiet" and
    "no reading" is the whole reason `parse_count` returns None.

    The count is the real assertion: it is 7, exactly MIN_SAMPLES, so the
    baseline clears the gate. Had the Nones become zeros it would be 9 and the
    median would be wrong — a baseline that passes every structural check and
    is still built partly on invented data.
    """
    values = [100, None, None, 120, 130, 140, 150, 160, 170]
    counts = twin_count_rows(MONDAY, 135)
    for weeks, value in enumerate(values, start=1):
        timestamp = weeks_before(MONDAY, weeks)
        if value is None:
            # A half-observed interval: the `in` flow arrived, the `out` did not.
            counts.append(count_row(SENSOR_A, "in", timestamp, 40))
            counts.append(count_row(SENSOR_B, "in", timestamp, 40))
        else:
            counts += twin_count_rows(timestamp, value)

    outcome = build(twin_rows(), counts)
    properties = properties_of(outcome)
    assert properties["observationCount"] == W.MIN_SAMPLES == 7
    assert properties["expected"] == 140
    assert properties["expected"] != 130
    assert outcome.report["sensors"]["pipeline"]["incompleteIntervals"] == 2
    assert outcome.report["sensors"]["pipeline"]["twinRowsCollapsed"] > 0


def test_the_four_value_case_from_the_spec_publishes_no_baseline():
    """[100, None, None, 120] leaves two usable samples, under MIN_SAMPLES.

    The two `None` intervals are half-observed: the `in` flow arrived and the
    `out` flow did not, so the interval has no total at all. If they had been
    read as zeros the count would be 4 and a median would be published from two
    real readings and two inventions.
    """
    counts = twin_count_rows(MONDAY, 110)
    counts += twin_count_rows(weeks_before(MONDAY, 1), 100)
    counts += twin_count_rows(weeks_before(MONDAY, 2), 120)
    for weeks in (3, 4):
        counts.append(count_row(SENSOR_A, "in", weeks_before(MONDAY, weeks), 5))
        counts.append(count_row(SENSOR_B, "in", weeks_before(MONDAY, weeks), 5))
    outcome = build(twin_rows(), counts)
    properties = properties_of(outcome)
    assert properties["observationCount"] == 2
    assert outcome.report["sensors"]["pipeline"]["incompleteIntervals"] == 2
    assert properties["expected"] is None
    assert properties["percentile"] is None
    assert properties["activity"] == "unavailable"


def test_a_genuine_zero_is_a_measurement():
    """Zero is what an empty street at 1am actually reads. It is not an absence."""
    counts = twin_count_rows(MONDAY, 0) + history_rows([0, 0, 0, 0, 10, 20, 30])

    outcome = build(twin_rows(), counts)
    properties = properties_of(outcome)
    assert properties["count"] == 0
    assert properties["expected"] == 0
    assert properties["observationCount"] == 7
    # 0/0 is undefined, so `ratio` is null rather than 0 — a third of typical
    # would be a fabricated claim.
    assert properties["ratio"] is None
    # The rank is arithmetically 29: 0 below, 4 equal, half of those credited
    # -> 2/7. It is still published, because it is a true statement about the
    # history. The LABEL is what the rule changes.
    assert properties["percentile"] == 29
    # ...and the LABEL is not "typical". See the zero-baseline rule below.
    assert properties["activity"] == "quiet"
    assert outcome.report["sensors"]["pipeline"]["zeroMedianIntervals"] == 1


def test_a_zero_median_bucket_is_quiet_not_typical():
    """The 61%-of-intervals-are-zero finding, fixed in the one source of truth.

    On the real 56-day snapshot 61.0% of all 10,649 complete in+out intervals
    are exactly 0, 60.6% of the 1,344 (weekday x 15-minute) keys have a median
    of exactly 0, and 341 keys are 0 in every one of their samples. Under a
    pure rank scheme every one of those buckets can only ever read 50 and is
    therefore always `typical` — so an empty park path at 1am on a Monday is
    published as confidently normal foot traffic, and "normal" here means the
    median observation is that nobody was there.

    The fix is not a special case for the number 0 in the build. It is one rule
    in `_common.activity_for`, keyed on the bucket's own published `expected`,
    so the build, the validator and the map cannot disagree about it.
    """
    # A bucket that is zero seven Mondays running, read as zero.
    properties = properties_of(build(twin_rows(), twin_count_rows(MONDAY, 0) + history_rows([0] * 7)))
    assert properties["expected"] == 0
    assert properties["percentile"] == 50   # 0 below, 7 equal, half credited
    assert properties["activity"] == "quiet"
    assert properties["ratio"] is None

    # The same bucket read as anything at all above zero: the rank is a clean
    # 100, because every historical sample is below it. `busy` and `veryBusy`
    # are both unsupported — a distribution of seven identical zeros has no
    # variance and no upper support, so a rank of 100 says only that the
    # reading is above seven zeros, which is not the same claim. The number is
    # published; the level is not.
    for reading in (1, 5, 40, 530):
        properties = properties_of(
            build(twin_rows(), twin_count_rows(MONDAY, reading) + history_rows([0] * 7))
        )
        assert properties["count"] == reading, reading
        assert properties["expected"] == 0
        assert properties["percentile"] == 100
        assert properties["activity"] == "unavailable", reading
        assert properties["ratio"] is None

    # ...and a bucket with a real baseline is untouched by any of this.
    properties = properties_of(
        build(twin_rows(), twin_count_rows(MONDAY, 135) + history_rows([100, 110, 120, 130, 140, 150, 160]))
    )
    assert properties["expected"] == 130
    assert properties["activity"] == "typical"


def test_the_zero_baseline_rule_is_derived_not_hardcoded():
    """`activity_for` refuses to run without being told the bucket's `expected`.

    Making the arguments required keyword parameters is the point: a caller
    that omits them cannot silently fall back to the rank-only behaviour, which
    is the bug. There is no default that means "assume a normal bucket".
    """
    with pytest.raises(TypeError):
        W.activity_for(50)  # type: ignore[call-type]
    with pytest.raises(TypeError):
        W.activity_for(50, expected=0)  # type: ignore[call-type]
    # A null percentile still wins, because that is the MIN_SAMPLES gate and it
    # is the stronger statement: no baseline at all, as against a baseline that
    # says zero.
    assert W.activity_for(None, expected=0, count=0) == "unavailable"
    assert W.activity_for(None, expected=0, count=9) == "unavailable"
    assert W.activity_for(None, expected=130, count=135) == "unavailable"


def test_a_zero_count_cell_is_not_treated_as_absent():
    assert W.parse_count("0") == 0
    properties = properties_of(
        build(twin_rows(), twin_count_rows(MONDAY, 0) + history_rows([0, 0, 0, 0, 10, 20, 30]))
    )
    assert properties["count"] == 0
    assert properties["observationCount"] == 7


def test_the_current_observation_is_excluded_from_its_own_baseline():
    counts = twin_count_rows(MONDAY, 135) + history_rows([100, 110, 120, 130, 140, 150, 160])
    assert properties_of(build(twin_rows(), counts))["observationCount"] == 7


def test_other_weekdays_and_buckets_are_not_mixed_in():
    """A Monday 01:00 reading is compared against Monday 01:00 readings only."""
    counts = twin_count_rows(MONDAY, 135) + history_rows([100, 110, 120, 130, 140, 150, 160])
    # A Tuesday at the same clock time, and the same weekday at 08:00. Neither
    # may leak into a Monday 01:00 baseline.
    counts += twin_count_rows(weeks_before(MONDAY, 1).replace("2026-09-21", "2026-09-22"), 9000)
    counts += twin_count_rows(weeks_before(MONDAY, 1).replace("01:00", "08:00"), 9000)
    counts += twin_count_rows(weeks_before(MONDAY, 2).replace("01:00", "08:00"), 9000)

    outcome = build(twin_rows(), counts)
    properties = properties_of(outcome)
    assert properties["observationCount"] == 7
    assert properties["expected"] == 130
    assert sensor_of(outcome)["baselineKey"] == "mon 01:00"
    assert properties["count"] == 135


# --------------------------------------------------------------------------- staleness


def source_text(utc_text: str) -> str:
    """A UTC instant as the source-frame string a count row would carry.

    The source column is New York CIVIL time — the spring-forward hour is
    absent from the real data, which a fixed offset cannot produce — so this is
    `astimezone(NYC_TZ)`, and in September the result is four hours behind UTC,
    not five. Getting this wrong shifts every fixture by an hour, which is the
    bug the timestamp tests exist to pin.
    """
    moment = datetime.fromisoformat(utc_text.replace("Z", "+00:00")).astimezone(W.NYC_TZ)
    return moment.strftime("%Y-%m-%dT%H:%M:%S.000")


def observation_at(utc_text: str, total: int = 40) -> list[dict]:
    """A reading at `utc_text` plus one a week earlier, so a baseline exists."""
    text = source_text(utc_text)
    return twin_count_rows(text, total) + twin_count_rows(weeks_before(text, 1), 30)


def test_fresh_stale_offline_and_never_observed():
    """All four states, from real ages rather than from `status`.

    Every pedestrian row in the source says `status: 'raw'`, so the field is
    constant across the fixture and cannot be what separates these four. NOW is
    2026-09-28T09:00:00Z, so the ages below are exact.

    The buckets are in units of the feed's DAILY batch, not of a live stream:
    fresh is within one batch cycle, stale is older than that but recent, and
    offline means nothing for days. A reading two hours old is `fresh`; a month
    old is `offline`. See FRESH_WITHIN in scripts/walk/_common.py.
    """
    fresh = properties_of(build(twin_rows(), observation_at("2026-09-28T08:00:00Z")))
    assert fresh["staleness"] == "fresh"
    assert fresh["active"] is True
    assert fresh["count"] == 40

    # Still inside one batch cycle: 26 hours, the age a working counter routinely
    # shows given a ~7h ingestion lag plus the partial current day.
    batch_lag = properties_of(build(twin_rows(), observation_at("2026-09-27T07:00:00Z")))
    assert batch_lag["staleness"] == "fresh"
    assert batch_lag["active"] is True
    # A real measurement, so the number stays.
    assert batch_lag["count"] == 40
    assert batch_lag["lastObservation"] == "2026-09-27T07:00:00Z"

    # Older than a cycle but inside the stale window: three days.
    stale = properties_of(build(twin_rows(), observation_at("2026-09-25T09:00:00Z")))
    assert stale["staleness"] == "stale"
    assert stale["active"] is False
    # Three days is still a real measurement, so the number stays.
    assert stale["count"] == 40
    assert stale["lastObservation"] == "2026-09-25T09:00:00Z"

    offline = properties_of(build(twin_rows(), observation_at("2026-06-28T09:00:00Z")))
    assert offline["staleness"] == "offline"
    assert offline["active"] is False
    assert offline["count"] is None
    assert offline["expected"] is None
    assert offline["percentile"] is None
    assert offline["ratio"] is None
    assert offline["activity"] == "unavailable"
    # ...but when it last spoke is exactly what a reader needs, so it survives.
    assert offline["lastObservation"] == "2026-06-28T09:00:00Z"
    assert offline["observedAt"] is None

    never = properties_of(build(twin_rows(), []))
    assert never["staleness"] == "unavailable"
    assert never["active"] is False
    assert never["count"] is None
    assert never["activity"] == "unavailable"
    assert never["observedAt"] is None
    assert never["lastObservation"] is None


def test_a_counter_whose_data_is_older_than_the_window_is_offline_not_unavailable():
    """The real High Bridge / Willis Ave case.

    Neither has a row inside a 56-day window, so the window alone cannot say
    when they stopped. The group-by in fetch_counts can, in eight rows.
    """
    sensors = twin_rows()
    outcome = build(
        sensors,
        [],
        extent=[
            {
                "sensor_id": SENSOR_A,
                "rows": "171368",
                "sumCounts": "559325",
                "firstObservation": "2023-12-27T10:00:00.000",
                "lastObservation": "2026-06-07T01:45:00.000",  # 05:45Z in EDT
            },
            {
                "sensor_id": SENSOR_B,
                "rows": "171368",
                "sumCounts": "559325",
                "firstObservation": "2023-12-27T10:00:00.000",
                "lastObservation": "2026-06-07T01:45:00.000",  # 05:45Z in EDT
            },
        ],
    )
    properties = properties_of(outcome)
    assert properties["staleness"] == "offline"
    assert properties["active"] is False
    assert properties["count"] is None
    assert properties["lastObservation"] == "2026-06-07T05:45:00Z"   # 01:45 EDT, not 01:45 EST
    assert properties["firstObservation"] == "2023-12-27T15:00:00Z"
    assert sensor_of(outcome)["lastObservationSource"] == "counts-extent"


def test_freshness_never_reads_the_status_column():
    counts = twin_count_rows(MONDAY, 40)
    for row in counts:
        row["status"] = "modified"
    outcome = build(twin_rows(), counts)
    assert properties_of(outcome)["staleness"] == "fresh"
    # Nothing about `status` reaches the published properties at all.
    assert "status" not in properties_of(outcome)


# --------------------------------------------------------------------------- determinism


def test_shuffled_input_produces_byte_identical_output():
    counts = twin_count_rows(MONDAY, 135)
    for weeks, historical in enumerate([100, 110, 120, 130, 140], start=1):
        counts += twin_count_rows(weeks_before(MONDAY, weeks), historical)
    sensors = twin_rows()
    sensors.append(sensor_row(id="300099999", name="Bike Only", travelmodes="bike", counters_serial=None))

    first = build(sensors, counts)
    second = build(list(reversed(sensors)), list(reversed(counts)))

    assert W.canonical_json(first.geojson()) == W.canonical_json(second.geojson())
    assert first.report["sensors"]["contentHash"] == second.report["sensors"]["contentHash"]
    assert first.report["sensors"]["contentHash"] == W.content_hash(first.features)
    assert W.canonical_json(first.latest) == W.canonical_json(second.latest)
    assert [f["id"] for f in first.features] == sorted(f["id"] for f in first.features)


def test_writing_twice_is_byte_identical(tmp_path):
    counts = twin_count_rows(MONDAY, 135)
    outcome = build(twin_rows(), counts)
    first = tmp_path / "a"
    second = tmp_path / "b"
    build_sensors.write(outcome, geojson_path=first / "sensors.geojson", latest_path=first / "latest.json")
    build_sensors.write(outcome, geojson_path=second / "sensors.geojson", latest_path=second / "latest.json")
    for name in ("sensors.geojson", "latest.json"):
        assert (first / name).read_bytes() == (second / name).read_bytes()


def test_published_artifacts_carry_no_build_timestamp():
    """A timestamp inside a published artifact makes every re-run rewrite it, and
    'did the data change?' stops being answerable."""
    outcome = build(twin_rows(), twin_count_rows(MONDAY, 135))
    assert "generatedAt" not in outcome.latest
    assert outcome.latest["latestObservation"] == "2026-09-28T05:00:00Z"   # 01:00 EDT
    assert outcome.latest["contentHash"] == outcome.report["sensors"]["contentHash"]


# --------------------------------------------------------------------------- rejections


def test_an_unresolvable_sensor_id_is_rejected_not_dropped():
    counts = twin_count_rows(MONDAY, 40) + twin_count_rows(
        MONDAY, 999, sensor_ids=("999999999",)
    )
    outcome = build(twin_rows(), counts)
    reasons = [item["reason"].split(":")[0] for item in outcome.report["sensors"]["rejections"]]
    assert reasons == ["unknown_sensor_id", "unknown_sensor_id"]
    assert outcome.report["sensors"]["pipeline"]["unknownSensorIds"] == 2


def test_a_bike_row_in_a_pedestrian_snapshot_is_rejected():
    counts = twin_count_rows(MONDAY, 40) + [count_row(SENSOR_A, "in", MONDAY, 5, travelmode="bike")]
    outcome = build(twin_rows(), counts)
    reasons = [item["reason"].split(":")[0] for item in outcome.report["sensors"]["rejections"]]
    assert "unexpected_travel_mode" in reasons
    assert outcome.report["sensors"]["pipeline"]["nonPedestrianRows"] == 1


def test_bike_only_counters_are_never_published():
    sensors = twin_rows() + [
        sensor_row(id="300011111", name="Bike Counter", travelmodes="bike", counters_serial="YAH00000001")
    ]
    outcome = build(sensors, twin_count_rows(MONDAY, 40))
    assert len(outcome.features) == 1
    assert outcome.report["sensors"]["pipeline"]["nonPedestrianSourceRows"] == 1


def test_an_unparseable_timestamp_is_counted_not_guessed():
    counts = twin_count_rows(MONDAY, 40) + [count_row(SENSOR_A, "in", "not a date", 5)]
    outcome = build(twin_rows(), counts)
    assert outcome.report["sensors"]["pipeline"]["unparseableTimestamps"] == 1
    assert properties_of(outcome)["count"] == 40


def test_no_counters_at_all_publishes_nothing_rather_than_pretending():
    """An empty sensor snapshot is a broken fetch, not an empty city. The build
    produces no features; the validator is what refuses to certify it."""
    outcome = build_sensors.build([], [], now=NOW)
    assert outcome.features == []
    assert outcome.latest["sensors"] == []
    result = validate_walk.validate(
        geojson=outcome.geojson(), latest=outcome.latest, min_sensors=1
    )
    assert any("refusing to certify an empty dataset" in message for message in result.errors)


# --------------------------------------------------------------------------- fetch_counts guards


def test_an_unbounded_fetch_is_refused_with_the_cost():
    with pytest.raises(W.PipelineError) as excinfo:
        fetch_counts.where_clause()
    message = str(excinfo.value)
    assert "21,300,000" in message
    assert "43,043" in message
    assert "--since" in message and "--latest" in message


def test_all_is_a_refusal_not_a_mode(capsys):
    assert fetch_counts.main(["--all"]) == 2
    assert "refused" in capsys.readouterr().err


def test_every_where_clause_restricts_to_pedestrian():
    start = fetch_counts.parse_date_bound("2026-07-14")
    end = fetch_counts.parse_date_bound("2026-09-28")
    where = fetch_counts.where_clause(start, end)
    assert where.startswith("travelmode='pedestrian'")
    assert fetch_counts.has_pedestrian_filter(where)
    assert f"timestamp >= '{fetch_counts.to_source_iso(start)}'" in where
    assert f"timestamp < '{fetch_counts.to_source_iso(end)}'" in where
    # There is no code path that builds a `$where` without it.
    for bad_start, bad_end in ((None, end), (start, None), (None, None)):
        with pytest.raises(W.PipelineError):
            fetch_counts.where_clause(bad_start, bad_end)


def test_a_one_sided_window_is_refused():
    start = fetch_counts.parse_date_bound("2026-07-14")
    with pytest.raises(W.PipelineError) as excinfo:
        fetch_counts.where_clause(start, None)
    assert "needs both ends" in str(excinfo.value)


def test_the_offset_ceiling_is_detected_rather_than_silently_truncating():
    where = fetch_counts.where_clause(
        fetch_counts.parse_date_bound("2020-01-01"), fetch_counts.parse_date_bound("2026-09-28")
    )
    with pytest.raises(W.PipelineError) as excinfo:
        fetch_counts.check_window_budget(where, 1_505_220)
    message = str(excinfo.value)
    assert "1,505,220" in message
    assert "43,000-row ceiling" in message
    assert "43000" in message
    assert "biased subset" in message
    assert "Refusing rather than truncating" in message
    # Exactly at the ceiling is allowed; one row over is not.
    fetch_counts.check_window_budget(where, W.MAX_SOCRATA_OFFSET)
    with pytest.raises(W.PipelineError):
        fetch_counts.check_window_budget(where, W.MAX_SOCRATA_OFFSET + 1)


def test_a_max_rows_above_the_socrata_ceiling_is_refused():
    with pytest.raises(W.PipelineError) as excinfo:
        fetch_counts.check_window_budget("travelmode='pedestrian'", 1, max_rows=50_000)
    assert "offset ceiling" in str(excinfo.value)


def test_counting_an_unfiltered_window_is_refused():
    with pytest.raises(W.PipelineError) as excinfo:
        fetch_counts.estimate_row_count("timestamp >= '2026-01-01T00:00:00'")
    assert "unfiltered window" in str(excinfo.value)


def test_a_full_56_day_window_does_NOT_fit_the_contract_ceiling_and_is_refused():
    """The sharp edge in the window budget, stated rather than smoothed over.

    Two counters are reporting, each published twice and split in/out:
    2 x 2 x 2 x 96 = 768 rows a day, so 56 days is 43,008 rows. The contract's
    `MAX_SOCRATA_OFFSET` is 43,000 — deliberately below Socrata's own 43,043,
    because a ceiling you can hit is a ceiling that truncates.

    So a COMPLETE 56-day window does not fit, by 8 rows, and `check_window_budget`
    refuses it rather than returning a window that would quietly drop its tail.
    It passes today only because the feed runs hours behind: a 56-day window
    ending now measures ~42,548 rows, not 43,008. That margin is ~450 rows,
    i.e. about 14 hours of feed lag.

    This test exists so the coupling is visible. If it ever has to give, the fix
    is `--baseline-window 55` (which still clears MIN_SAMPLES at 7) or splitting
    the first fetch in two — NOT raising the ceiling, because 43,008 rows cannot
    be paged in one request.
    """
    rows_per_day_per_counter = 2 * 2 * 96          # 2 twins x 2 directions x 96 buckets
    assert rows_per_day_per_counter == 384
    two_counters = 2 * rows_per_day_per_counter    # 768 rows a day, as measured
    assert two_counters * 56 == 43_008
    assert two_counters * 56 > W.MAX_SOCRATA_OFFSET
    with pytest.raises(W.PipelineError) as excinfo:
        fetch_counts.check_window_budget("travelmode='pedestrian'", two_counters * 56)
    assert "biased subset" in str(excinfo.value)
    # 55 days does fit, and still gives 7 samples per weekday/bucket.
    assert two_counters * 55 == 42_240
    assert two_counters * 55 <= W.MAX_SOCRATA_OFFSET
    # A third live counter adds 384 a day, and 56 days is then far out of reach:
    # the ceiling allows 37 days, at which point there are 5 samples per bucket
    # and a p90 label rests on the largest of five. That is the number to
    # re-check when the third counter comes back.
    assert (two_counters + rows_per_day_per_counter) * 56 > W.MAX_SOCRATA_OFFSET
    assert W.MAX_SOCRATA_OFFSET // (two_counters + rows_per_day_per_counter) == 37
    assert fetch_counts.DEFAULT_BASELINE_WINDOW_DAYS == 56


def test_windows_are_bounded_and_incremental():
    now = fetch_counts.source_now()

    first = fetch_counts.resolve_window(now=now, baseline_window_days=56)
    assert first.reason.startswith("first run")
    assert round(first.days) == 56

    latest = fetch_counts.resolve_window(now=now, latest=True)
    assert latest.reason == "latest interval"
    assert round(latest.days) == 1

    since = fetch_counts.resolve_window(now=now, since="2026-08-01")
    assert since.reason == "since 2026-08-01"
    assert since.start == fetch_counts.parse_date_bound("2026-08-01")

    resumed = fetch_counts.resolve_window(now=now, watermark="2026-09-27T01:15:00")
    assert resumed.reason == "incremental from watermark"
    # Overlaps the watermark so no interval can be skipped, and never starts
    # after it.
    assert resumed.start < fetch_counts.parse_date_bound("2026-09-27T01:15:00")
    assert resumed.end == now

    with pytest.raises(W.PipelineError):
        fetch_counts.resolve_window(now=now, since="2027-01-01")
    with pytest.raises(W.PipelineError):
        fetch_counts.resolve_window(now=now, baseline_window_days=0)


def test_an_unparseable_since_is_refused():
    with pytest.raises(W.PipelineError) as excinfo:
        fetch_counts.parse_date_bound("last tuesday")
    assert "YYYY-MM-DD" in str(excinfo.value)


def test_rows_merge_and_dedupe_on_the_natural_key():
    first = twin_count_rows(MONDAY, 100)
    second = twin_count_rows(MONDAY, 100)  # the 30-minute overlap, unchanged
    merged, duplicates = fetch_counts.merge_rows(first, second)
    assert len(merged) == 4
    assert duplicates == 4
    # Order does not depend on which batch arrived first.
    other, duplicates = fetch_counts.merge_rows(second, first)
    assert W.canonical_json(merged) == W.canonical_json(other)
    assert duplicates == 4


def test_rows_outside_the_retention_window_are_pruned():
    old = twin_count_rows("2020-01-01T01:00:00.000", 10)
    keep_from = fetch_counts.parse_source_bound("2026-09-01T00:00:00")
    assert fetch_counts.prune_to_window(old, keep_from) == []
    recent = twin_count_rows(MONDAY, 10)
    assert len(fetch_counts.prune_to_window(recent, keep_from)) == 4


def test_the_extent_probe_finds_the_four_twin_pairs():
    """Measured on the live dataset, 2026-09-28: eight sensor ids, four pairs,
    each pair identical in row count, sum, first and last observation."""
    extent = [
        {"sensor_id": "300028963", "rows": "214172", "sumCounts": "1867502",
         "firstObservation": "2022-09-02T11:15:00.000", "lastObservation": "2025-09-22T01:30:00.000"},
        {"sensor_id": "300029648", "rows": "214172", "sumCounts": "1867502",
         "firstObservation": "2022-09-02T11:15:00.000", "lastObservation": "2025-09-22T01:30:00.000"},
        {"sensor_id": "300038506", "rows": "171368", "sumCounts": "559325",
         "firstObservation": "2023-12-27T10:00:00.000", "lastObservation": "2026-06-07T01:45:00.000"},
        {"sensor_id": "300038509", "rows": "193042", "sumCounts": "963979",
         "firstObservation": "2023-12-27T12:15:00.000", "lastObservation": "2026-09-28T01:15:00.000"},
        {"sensor_id": "300040736", "rows": "174028", "sumCounts": "351606",
         "firstObservation": "2024-04-04T13:45:00.000", "lastObservation": "2026-09-28T01:00:00.000"},
        {"sensor_id": "300043073", "rows": "174028", "sumCounts": "351606",
         "firstObservation": "2024-04-04T13:45:00.000", "lastObservation": "2026-09-28T01:00:00.000"},
        {"sensor_id": "300043075", "rows": "193042", "sumCounts": "963979",
         "firstObservation": "2023-12-27T12:15:00.000", "lastObservation": "2026-09-28T01:15:00.000"},
        {"sensor_id": "300043077", "rows": "171368", "sumCounts": "559325",
         "firstObservation": "2023-12-27T10:00:00.000", "lastObservation": "2026-06-07T01:45:00.000"},
    ]
    groups = fetch_counts.twin_groups_from_extent(extent)
    assert groups == [
        ["300028963", "300029648"],
        ["300038506", "300043077"],
        ["300038509", "300043075"],
        ["300040736", "300043073"],
    ]
    assert sum(1 for members in groups for _ in members) == len(extent)


def test_the_citywide_figure_is_exactly_twice_the_physical_one():
    """`sum(counts)` over all 1,505,220 pedestrian rows is 7,484,824. Half of
    that is what the city actually measured."""
    doubled = 300028963 and 7_484_824
    assert doubled % 2 == 0
    assert doubled // 2 == 3_742_412


def test_fetch_meta_records_provenance_and_a_content_hash(tmp_path):
    raw = tmp_path / "counts.json"
    meta_path = tmp_path / "counts-meta.json"
    window = fetch_counts.resolve_window(
        now=fetch_counts.source_now(), since="2026-09-01"
    )
    where = fetch_counts.where_clause(window.start, window.end)
    rows = twin_count_rows(MONDAY, 100)
    meta = fetch_counts.build_fetch_meta(
        rows=rows,
        where=where,
        window=window,
        view_meta={"rowsUpdatedAt": 1790598078},
        extent=[
            {"sensor_id": SENSOR_A, "rows": "4", "sumCounts": "400", "firstObservation": None, "lastObservation": None},
            {"sensor_id": SENSOR_B, "rows": "4", "sumCounts": "400", "firstObservation": None, "lastObservation": None},
        ],
        fetched=len(rows),
        duplicates=0,
        pruned=0,
        previous_rows=0,
        baseline_window_days=56,
    )
    C = W
    C.write_json_file(raw, rows)
    C.write_json_file(meta_path, meta)

    assert meta["where"] == where
    assert meta["rowCount"] == 4
    assert meta["watermark"] == "2026-09-28T01:00:00"
    assert meta["watermarkUtc"] == "2026-09-28T05:00:00Z"   # 01:00 EDT, not 06:00
    assert meta["maxOffset"] == W.MAX_SOCRATA_OFFSET
    assert meta["select"] == ",".join(fetch_counts.COUNT_COLUMNS)
    assert meta["contentHash"] == W.sha256_hex(
        W.canonical_json(rows).encode("utf-8")
    )
    assert meta["sourceUpdatedAt"] == "2026-09-28T12:21:18Z"
    assert meta["pedestrianTotals"]["twinGroups"] == 1
    # The doubled and the physical figure are both recorded, so the merge is
    # arithmetic anyone can check.
    assert meta["pedestrianTotals"]["sumCountsTwinDoubled"] == 800
    assert meta["pedestrianTotals"]["sumCountsPhysical"] == 400


# --------------------------------------------------------------------------- validation


def validated(outcome, count_rows=None, sensor_rows=None):
    return validate_walk.validate(
        geojson=outcome.geojson(),
        latest=outcome.latest,
        count_rows=count_rows,
        sensor_rows=sensor_rows,
        min_sensors=0,
    )


def sample_outcome():
    counts = twin_count_rows(MONDAY, 135) + history_rows([100, 110, 120, 130, 140, 150, 160])
    return build(twin_rows(), counts), counts


def test_a_healthy_build_validates():
    outcome, counts = sample_outcome()
    result = validated(outcome, count_rows=counts, sensor_rows=twin_rows())
    assert result.errors == []
    assert result.stats["sensorCount"] == 1
    assert result.stats["uniqueSerials"] == 1
    assert result.stats["uniqueSourceIds"] == 2


def test_a_duplicate_counter_serial_is_a_failed_twin_collapse():
    outcome, counts = sample_outcome()
    twin_feature = copy.deepcopy(outcome.features[0])
    twin_feature["id"] = W.sensor_id("YAH99999999")
    twin_feature["properties"]["id"] = W.sensor_id("YAH99999999")
    twin_feature["properties"]["counterSerial"] = "YAH99999999"
    # A twin that failed to collapse: a different serial, the same coordinates
    # and the same source sensor ids. The most plausible-looking 2x bug there is.
    result = validate_walk.validate(
        geojson={"type": "FeatureCollection", "features": outcome.features + [twin_feature]},
        latest=outcome.latest,
        min_sensors=0,
    )
    messages = " ".join(result.errors)
    assert "source sensor_id" in messages
    assert "published twice" in messages


def test_the_same_serial_published_twice_is_caught():
    outcome, counts = sample_outcome()
    twin_feature = copy.deepcopy(outcome.features[0])
    twin_feature["properties"]["sensorIds"] = ["300099999"]
    result = validate_walk.validate(
        geojson={"type": "FeatureCollection", "features": outcome.features + [twin_feature]},
        latest=outcome.latest,
        min_sensors=0,
    )
    assert any("counterSerial" in message and "published by" in message for message in result.errors)


def test_a_bad_published_id_is_caught():
    outcome, counts = sample_outcome()
    broken = copy.deepcopy(outcome.geojson())
    broken["features"][0]["properties"]["id"] = "wsk-nothex"
    broken["features"][0]["id"] = "wsk-nothex"
    result = validate_walk.validate(geojson=broken, latest=outcome.latest, min_sensors=0)
    assert any("does not match" in message for message in result.errors)


def test_an_id_that_is_not_the_serial_hash_is_caught():
    outcome, counts = sample_outcome()
    broken = copy.deepcopy(outcome.geojson())
    properties = broken["features"][0]["properties"]
    properties["id"] = W.sensor_id("YAH00000000")
    broken["features"][0]["id"] = properties["id"]
    result = validate_walk.validate(geojson=broken, latest=outcome.latest, min_sensors=0)
    assert any("is not sha1(counterSerial" in message for message in result.errors)


@pytest.mark.parametrize(
    "field,value",
    [
        ("count", "135"),
        ("expected", 130.5),
        ("percentile", "57"),
        ("ratio", "1.125"),
        ("observationCount", None),
        ("directional", "true"),
        ("sensorIds", "300040736"),
        ("active", "true"),
        ("staleness", 3),
    ],
)
def test_a_wrong_property_type_is_caught(field, value):
    outcome, counts = sample_outcome()
    broken = copy.deepcopy(outcome.geojson())
    broken["features"][0]["properties"][field] = value
    result = validate_walk.validate(geojson=broken, latest=outcome.latest, min_sensors=0)
    assert result.errors, f"a {field} of {value!r} should not validate"


def test_a_missing_or_extra_property_is_caught():
    outcome, _ = sample_outcome()
    missing = copy.deepcopy(outcome.geojson())
    del missing["features"][0]["properties"]["ratio"]
    assert any(
        "missing 'ratio'" in message
        for message in validate_walk.validate(geojson=missing, latest=outcome.latest, min_sensors=0).errors
    )
    extra = copy.deepcopy(outcome.geojson())
    extra["features"][0]["properties"]["status"] = "raw"
    assert any(
        "unexpected key" in message
        for message in validate_walk.validate(geojson=extra, latest=outcome.latest, min_sensors=0).errors
    )


def test_a_baseline_from_too_few_samples_is_caught():
    """The published artifact claiming `expected` with 2 observations behind it
    is a confident guess, and the validator refuses to certify it."""
    outcome, _ = sample_outcome()
    broken = copy.deepcopy(outcome.geojson())
    broken["features"][0]["properties"]["observationCount"] = 2
    messages = " ".join(
        validate_walk.validate(geojson=broken, latest=outcome.latest, min_sensors=0).errors
    )
    assert f"below MIN_SAMPLES={W.MIN_SAMPLES}" in messages
    assert "must be 'unavailable'" in messages


def _zero_baseline_outcome():
    """A live counter whose bucket's own median is zero: 7 zeros, read 0."""
    return build(twin_rows(), twin_count_rows(MONDAY, 0) + history_rows([0] * 7))


def test_a_level_published_on_a_zero_baseline_is_caught():
    """The validator recomputes the zero-baseline rule from published fields.

    This is the check that stops the build and the contract drifting apart, and
    it is only possible because the rule is keyed on the PUBLISHED rounded
    median rather than on the raw one, which the validator cannot see.
    """
    outcome = _zero_baseline_outcome()
    assert outcome.features[0]["properties"]["activity"] == "quiet"
    for wrong in ("typical", "busy", "veryBusy"):
        broken = copy.deepcopy(outcome.geojson())
        broken["features"][0]["properties"]["activity"] = wrong
        messages = " ".join(
            validate_walk.validate(geojson=broken, latest=outcome.latest, min_sensors=0).errors
        )
        assert "expected is 0" in messages, wrong
        assert wrong in messages, wrong
    # ...and the reverse direction: a reading ABOVE a zero baseline must not be
    # published as a level either, and the correct label is `unavailable`.
    above = build(twin_rows(), twin_count_rows(MONDAY, 5) + history_rows([0] * 7))
    assert above.features[0]["properties"]["activity"] == "unavailable"
    for wrong in ("quiet", "typical", "busy", "veryBusy"):
        broken = copy.deepcopy(above.geojson())
        broken["features"][0]["properties"]["activity"] = wrong
        messages = " ".join(
            validate_walk.validate(geojson=broken, latest=above.latest, min_sensors=0).errors
        )
        assert "zero-expected bucket must be 'unavailable'" in messages, wrong


def test_a_ratio_published_against_a_zero_baseline_is_caught():
    outcome = _zero_baseline_outcome()
    assert outcome.features[0]["properties"]["ratio"] is None
    broken = copy.deepcopy(outcome.geojson())
    broken["features"][0]["properties"]["ratio"] = 0.0
    messages = " ".join(
        validate_walk.validate(geojson=broken, latest=outcome.latest, min_sensors=0).errors
    )
    assert "there is no ratio to publish" in messages


def test_the_zero_baseline_rule_leaves_a_real_baseline_alone():
    """The checks above must not become a blanket ban on levels."""
    outcome, _ = sample_outcome()
    assert outcome.features[0]["properties"]["expected"] == 130
    assert outcome.features[0]["properties"]["activity"] == "typical"
    result = validate_walk.validate(
        geojson=outcome.geojson(), latest=outcome.latest, min_sensors=0
    )
    assert not [message for message in result.errors if "expected is 0" in message]


def test_an_activity_outside_the_published_set_is_caught():
    outcome, _ = sample_outcome()
    broken = copy.deepcopy(outcome.geojson())
    broken["features"][0]["properties"]["activity"] = "extremelyBusy"
    result = validate_walk.validate(geojson=broken, latest=outcome.latest, min_sensors=0)
    assert any("activity" in message and "not one of" in message for message in result.errors)


def test_a_staleness_outside_the_published_set_is_caught():
    outcome, _ = sample_outcome()
    broken = copy.deepcopy(outcome.geojson())
    broken["features"][0]["properties"]["staleness"] = "sortof"
    broken["features"][0]["properties"]["active"] = False
    result = validate_walk.validate(geojson=broken, latest=outcome.latest, min_sensors=0)
    assert any("staleness" in message and "not one of" in message for message in result.errors)


def test_a_count_on_a_dead_counter_is_caught():
    outcome, _ = sample_outcome()
    broken = copy.deepcopy(outcome.geojson())
    properties = broken["features"][0]["properties"]
    properties["staleness"] = "offline"
    properties["active"] = False
    result = validate_walk.validate(geojson=broken, latest=outcome.latest, min_sensors=0)
    messages = " ".join(result.errors)
    assert "on a offline counter" in messages or "on an offline counter" in messages


def test_an_inconsistent_ratio_is_caught():
    outcome, _ = sample_outcome()
    broken = copy.deepcopy(outcome.geojson())
    broken["features"][0]["properties"]["ratio"] = 0.5
    result = validate_walk.validate(geojson=broken, latest=outcome.latest, min_sensors=0)
    assert any("count/expected" in message for message in result.errors)


def test_a_fresh_counter_with_no_observation_is_caught():
    outcome, _ = sample_outcome()
    broken = copy.deepcopy(outcome.geojson())
    properties = broken["features"][0]["properties"]
    properties["count"] = None
    result = validate_walk.validate(geojson=broken, latest=outcome.latest, min_sensors=0)
    assert any("is fresh but has observedAt" in message for message in result.errors)


def test_a_negative_count_is_caught():
    outcome, _ = sample_outcome()
    broken = copy.deepcopy(outcome.geojson())
    broken["features"][0]["properties"]["count"] = -1
    result = validate_walk.validate(geojson=broken, latest=outcome.latest, min_sensors=0)
    assert any("negative" in message for message in result.errors)


def test_an_out_of_bbox_point_is_caught():
    outcome, _ = sample_outcome()
    broken = copy.deepcopy(outcome.geojson())
    broken["features"][0]["geometry"]["coordinates"] = [-73.0, 42.0]
    result = validate_walk.validate(geojson=broken, latest=outcome.latest, min_sensors=0)
    assert any("outside the NYC bounding box" in message for message in result.errors)


def test_the_twin_collapse_invariant_is_checked_against_the_raw_rows():
    """I3 and I4, from the snapshot rather than from the build.

    Doubling the published `count` — what a sensor_id-keyed aggregation would
    produce — must fail, and so must twins that no longer agree.
    """
    outcome, counts = sample_outcome()
    assert validated(outcome, count_rows=counts).errors == []

    doubled = copy.deepcopy(outcome.geojson())
    doubled["features"][0]["properties"]["count"] = 270
    result = validate_walk.validate(
        geojson=doubled, latest=outcome.latest, count_rows=counts, min_sensors=0
    )
    assert any(
        "in+out over the raw rows of the representative sensor id" in message
        for message in result.errors
    )

    diverged = [dict(row) for row in counts]
    for row in diverged:
        if row["sensor_id"] == SENSOR_B and row["timestamp"] == MONDAY and row["direction"] == "in":
            row["counts"] = "1"
    result = validate_walk.validate(
        geojson=outcome.geojson(), latest=outcome.latest, count_rows=diverged, min_sensors=0
    )
    assert any("twin-collapse invariant failed" in message for message in result.errors)


def test_a_published_counter_that_does_not_resolve_is_caught():
    """The published feature claims a counter the sensor snapshot knows nothing
    about — the signature of a stale snapshot, or of a hand-edited artifact."""
    outcome, _ = sample_outcome()
    other = [sensor_row(id="300088888", name="Some Other Park", counters_serial="YAH00000002")]
    result = validated(outcome, sensor_rows=other)
    messages = " ".join(result.errors)
    assert "does not resolve to a physical counter" in messages
    assert "no pedestrian counter in 6up2-gnw8 claims" in messages


def test_a_counter_count_collapse_is_caught():
    outcome, _ = sample_outcome()
    result = validate_walk.validate(
        geojson=outcome.geojson(), latest=outcome.latest, min_sensors=4
    )
    assert any("counter count collapse" in message for message in result.errors)


def test_an_empty_feature_collection_is_never_certified():
    empty = build_sensors.build([], [], now=NOW)
    result = validate_walk.validate(
        geojson=empty.geojson(), latest=empty.latest, min_sensors=0
    )
    assert any("refusing to certify an empty dataset" in message for message in result.errors)


def test_missing_artifacts_are_reported_not_raised(tmp_path):
    result = validate_walk.validate_paths(out_dir=tmp_path / "nothing-here")
    assert result.errors
    assert "missing artifact" in result.errors[0]


def test_a_new_categorical_warns_rather_than_fails():
    """Drift is loud but not fatal, unless it would make processing unsafe."""
    outcome, counts = sample_outcome()
    drifted = [dict(row) for row in counts]
    for row in drifted:
        row["granularity"] = "PT5M"
    result = validate_walk.validate(
        geojson=outcome.geojson(), latest=outcome.latest, count_rows=drifted, min_sensors=0
    )
    assert result.errors == []
    assert any("PT5M" in warning for warning in result.warnings)


def test_validate_is_importable_and_takes_no_repo_paths():
    outcome, _ = sample_outcome()
    assert validate_walk.validate(
        geojson=outcome.geojson(), latest=outcome.latest, min_sensors=0
    ).errors == []


# --------------------------------------------------------------------------- round trip


def test_a_build_validate_refresh_cycle_on_a_tmp_dir(tmp_path, monkeypatch, capsys):
    """What CI can smoke-test: raw snapshots in, published artifacts out, no
    network, no repo state touched."""
    import refresh

    sensors_path = tmp_path / "sensors-6up2-gnw8.json"
    sensors_meta = tmp_path / "sensors-fetch-meta.json"
    counts_path = tmp_path / "counts.json"
    counts_meta = tmp_path / "counts-meta.json"
    out_dir = tmp_path / "out"

    counts = twin_count_rows(MONDAY, 135)
    for weeks, historical in enumerate([100, 110, 120, 130, 140], start=1):
        counts += twin_count_rows(weeks_before(MONDAY, weeks), historical)
    W.write_json_file(sensors_path, twin_rows())
    W.write_json_file(
        sensors_meta,
        {"contentHash": W.sha256_hex(W.canonical_json(twin_rows()).encode("utf-8"))},
    )
    W.write_json_file(counts_path, counts)

    monkeypatch.setattr(W, "SENSORS_RAW_PATH", sensors_path)
    monkeypatch.setattr(W, "SENSORS_META_PATH", sensors_meta)
    monkeypatch.setattr(W, "COUNTS_RAW_PATH", counts_path)
    monkeypatch.setattr(W, "COUNTS_META_PATH", counts_meta)

    args = ["--offline", "--out-dir", str(out_dir), "--now", NOW, "--min-sensors", "1"]
    assert refresh.main(args) == 0
    first = (out_dir / "sensors.geojson").read_bytes(), (out_dir / "latest.json").read_bytes()
    capsys.readouterr()

    assert refresh.main(args) == 0
    output = capsys.readouterr().out
    assert "unchanged" in output
    assert (out_dir / "sensors.geojson").read_bytes(), (out_dir / "latest.json").read_bytes()
    assert (
        (out_dir / "sensors.geojson").read_bytes(),
        (out_dir / "latest.json").read_bytes(),
    ) == first


def test_a_dry_run_writes_nothing(tmp_path, monkeypatch, capsys):
    import refresh

    sensors_path = tmp_path / "sensors.json"
    W.write_json_file(sensors_path, twin_rows())
    W.write_json_file(tmp_path / "sensors-meta.json", {})
    W.write_json_file(tmp_path / "counts.json", twin_count_rows(MONDAY, 135))
    monkeypatch.setattr(W, "SENSORS_RAW_PATH", sensors_path)
    monkeypatch.setattr(W, "SENSORS_META_PATH", tmp_path / "sensors-meta.json")
    monkeypatch.setattr(W, "COUNTS_RAW_PATH", tmp_path / "counts.json")
    monkeypatch.setattr(W, "COUNTS_META_PATH", tmp_path / "counts-meta.json")

    out_dir = tmp_path / "out"
    assert refresh.main(
        ["--offline", "--dry-run", "--out-dir", str(out_dir), "--now", NOW, "--min-sensors", "1"]
    ) == 0
    assert not out_dir.exists()
    assert "--dry-run and --out-dir together" in capsys.readouterr().out
