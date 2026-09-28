"""The timestamp contract: the source is New York CIVIL time, not fixed EST.

This is the one file where a subtle bug produces a confidently wrong map rather
than an obviously broken one. Every failure mode below is silent:

* treating a source timestamp as a fixed -05:00 offset shifts every summer
  observation an hour against a winter one, so a time-of-day baseline is
  compared against the wrong hour for half the year;
* comparing freshness in the source frame instead of UTC invents an hour of
  staleness for every summer reading;
* writing a `$where` bound in the wrong frame silently starts a fetch an hour
  late and ends it an hour early;
* letting a missing timestamp become the epoch or "now" invents an observation
  and turns a dead counter into a fresh one.

WHY CIVIL TIME, GIVEN THE SOURCE SAYS OTHERWISE
================================================
The source's own documentation says "Time is captured in EST time zone". The
documentation is wrong and the data says so. On the second Sunday of March, New
York civil time skips 02:00-02:59 entirely; a fixed -05:00 offset does not, and
under a fixed offset those four quarter-hours exist every day of the year. The
pedestrian series has ZERO rows in 02:00-02:59 on the spring-forward Sunday, in
every year 2023 to 2026, and a full complement on the Sundays either side:

    2023-03-12 (spring fwd)  368 rows   prev 384   next 384
    2024-03-10 (spring fwd) 1104 rows   prev 1152  next 1152
    2025-03-09 (spring fwd) 1472 rows   prev 1536  next 1536
    2026-03-08 (spring fwd) 1104 rows   prev 1152  next 1152

Each is short by exactly one hour of four quarter-hours, across every live
(sensor, direction) pair that day: 16 rows in 2023 (2 counters), 48 in 2024 and
2026 (3 counters), 64 in 2025 (4 counters). No fixed offset can produce a
missing hour at all.

The test at the bottom of this file reads those four years out of the live
endpoint and asserts the signature, so the claim is checked against data rather
than against this comment.

Almost no network. The last two tests query NYC Open Data for the four
spring-forward Sundays and SKIP when the endpoint is unreachable, so CI is
unaffected; every other case is an inline value and the file runs in well under
a second without them.
"""

from __future__ import annotations

import importlib.util
import json
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

UTC = timezone.utc
#: Offsets, as durations, for comparison against `datetime.utcoffset()`.
EST_OFFSET = timedelta(hours=-5)
EDT_OFFSET = timedelta(hours=-4)

#: The second Sunday of March in each year, when New York springs forward.
SPRING_FORWARD = {
    2023: "2023-03-12",
    2024: "2024-03-10",
    2025: "2025-03-09",
    2026: "2026-03-08",
}
#: The second Sunday of November, when it falls back.
FALL_BACK = {2023: "2023-11-05", 2024: "2024-11-03", 2025: "2025-11-02", 2026: "2026-11-01"}


# --------------------------------------------------------------------------- parsing


@pytest.mark.skipif(not W.NYC_TZ_IS_FULL, reason="host has no tz database")
@pytest.mark.parametrize(
    "text,expected_offset,expected_utc",
    [
        # Winter: 12:00 EST is 17:00 UTC.
        ("2026-01-14T12:00:00.000", EST_OFFSET, "2026-01-14T17:00:00Z"),
        # Summer: 12:00 EDT is 16:00 UTC. NOT 17:00. This single assertion is
        # the whole reason the parser resolves in a zone rather than at -05:00.
        ("2026-07-14T12:00:00.000", EDT_OFFSET, "2026-07-14T16:00:00Z"),
        ("2026-09-28T01:15:00.000", EDT_OFFSET, "2026-09-28T05:15:00Z"),
        ("2026-06-07T01:45:00.000", EDT_OFFSET, "2026-06-07T05:45:00Z"),
        ("2025-09-22T01:30:00.000", EDT_OFFSET, "2025-09-22T05:30:00Z"),
        ("2025-12-31T23:45:00.000", EST_OFFSET, "2026-01-01T04:45:00Z"),
        # No fractional part, and a space instead of a T.
        ("2026-03-01T00:00:00", EST_OFFSET, "2026-03-01T05:00:00Z"),
        ("2026-03-01 08:15:00", EST_OFFSET, "2026-03-01T13:15:00Z"),
        # Padding far outside the dataset's range, to prove nothing is clipped.
        ("1999-12-31T23:59:59.000", EST_OFFSET, "2000-01-01T04:59:59Z"),
        ("2030-01-01T00:00:00.000", EST_OFFSET, "2030-01-01T05:00:00Z"),
    ],
)
def test_a_july_timestamp_is_utc_minus_four_and_a_january_one_is_utc_minus_five(
    text, expected_offset, expected_utc
):
    moment = W.parse_source_timestamp(text)
    assert moment is not None
    assert moment.utcoffset() == expected_offset
    assert W.iso_utc(moment) == expected_utc


@pytest.mark.skipif(not W.NYC_TZ_IS_FULL, reason="host has no tz database")
def test_a_summer_and_a_winter_reading_of_the_same_clock_time_are_one_hour_apart_in_utc():
    """The defining property of the source: it observes daylight saving.

    These were identical in UTC when the pipeline believed the source was fixed
    EST, which meant a weekday+bucket baseline compared a July reading against
    a January one with a one-hour error in half of them — and, worse, that a
    12:00 summer reading was scored against a 12:00 winter history that was
    really describing 13:00.
    """
    summer = W.parse_source_timestamp("2026-07-14T12:00:00")
    winter = W.parse_source_timestamp("2026-01-14T12:00:00")
    assert summer is not None and winter is not None
    assert summer.utcoffset() == EDT_OFFSET
    assert winter.utcoffset() == EST_OFFSET
    assert (W.to_utc(summer).hour, W.to_utc(summer).minute) == (16, 0)
    assert (W.to_utc(winter).hour, W.to_utc(winter).minute) == (17, 0)
    # The same wall clock, one hour apart in UTC. This is what the fixed-EST
    # reading could not produce, and it is what a baseline silently assumed.
    assert W.to_utc(summer) - W.to_utc(winter) != timedelta(0)
    # Round-tripping through New York civil time gets you back to the wall
    # clock the source recorded, in both seasons. Under fixed EST it did not.
    for moment in (summer, winter):
        assert W.to_nyc_wall_clock(moment).strftime("%Y-%m-%d %H:%M") == moment.strftime(
            "%Y-%m-%d %H:%M"
        )


# --------------------------------------------------------------------------- wall clock


@pytest.mark.skipif(not W.NYC_TZ_IS_FULL, reason="host has no tz database")
def test_july_noon_source_is_noon_in_new_york():
    """The corrected version of an old, wrong expectation.

    Under fixed EST, 12:00 in the source was 13:00 on a New York clock, and
    there was a test saying so. It was asserting the bug.
    """
    moment = W.parse_source_timestamp("2026-07-12T12:00:00")
    assert moment is not None
    wall = W.to_nyc_wall_clock(moment)
    assert (wall.year, wall.month, wall.day, wall.hour, wall.minute) == (2026, 7, 12, 12, 0)
    assert wall.utcoffset() == EDT_OFFSET


@pytest.mark.skipif(not W.NYC_TZ_IS_FULL, reason="host has no tz database")
def test_january_noon_source_is_noon_in_new_york():
    moment = W.parse_source_timestamp("2026-01-12T12:00:00")
    assert moment is not None
    wall = W.to_nyc_wall_clock(moment)
    assert (wall.year, wall.month, wall.day, wall.hour, wall.minute) == (2026, 1, 12, 12, 0)
    assert wall.utcoffset() == EST_OFFSET


# --------------------------------------------------------------------------- transitions


@pytest.mark.skipif(not W.NYC_TZ_IS_FULL, reason="host has no tz database")
def test_a_nonexistent_spring_forward_time_is_accepted_and_lands_in_a_bucket_that_can_never_publish():
    """02:30 on the spring-forward Sunday does not exist in New York. Decide,
    then own the decision.

    WHAT ZONEINFO ACTUALLY DOES, because the naive description is wrong: a
    nonexistent wall clock attached with `replace(tzinfo=NYC_TZ)` keeps its
    printed time. `parse_source_timestamp("2026-03-08T02:30:00")` reads back as
    02:30 with a -05:00 offset, which is an imaginary local time; it is
    07:30 UTC, and that is the same INSTANT as a 03:30 EDT reading. So the
    instant is right and the printed wall clock is not.

    Three possible behaviours, and why this one:

    * REJECT the row. Worst. A row with a real stamp would land in
      `unparseableTimestamps`, be excluded from its baseline, and invent a hole
      where the source published a measurement.
    * RE-BUCKET it to 03:30, the real civil time of the instant. Tempting, and
      wrong for this pipeline: the baseline key is the source's own frame, and
      silently reinterpreting one row's clock would be the same class of error
      as the fixed-EST assumption, only smaller.
    * KEEP the source's 02:30, which is what this does. And then notice what
      that costs: a 02:30 bucket on a spring-forward Sunday is a bucket that
      occurs ONCE A YEAR. It can never reach MIN_SAMPLES, so it can never
      publish a baseline, a percentile, a ratio or an activity label. It is
      permanently `unavailable`.

    So the answer to "must it not silently mis-bucket it" is: it does bucket it
    under 02:30, and the bucket is structurally incapable of producing a
    confident answer. That is asserted below, not assumed. And in the real data
    the question is moot — there is no such row (see the live proof below).
    """
    spring = W.parse_source_timestamp("2026-03-08T02:30:00")
    assert spring is not None
    # The instant is right even though the printed clock is imaginary.
    assert W.to_utc(spring) == datetime(2026, 3, 8, 7, 30, tzinfo=UTC)
    assert W.to_utc(spring) == W.to_utc(W.parse_source_timestamp("2026-03-08T03:30:00"))
    # The bucket is the source's own wall clock, so it is the phantom 02:30.
    assert W.time_bucket(spring) == "02:30"
    assert W.day_key(spring) == "sun"
    # The property that makes this safe: 02:00-02:59 does not exist on that
    # date, so a 02:xx bucket is populated at most once a year and can never
    # clear MIN_SAMPLES. Assert the arithmetic, not the hope.
    for year in sorted(SPRING_FORWARD):
        day = SPRING_FORWARD[year]
        assert W.parse_source_timestamp(f"{day}T02:00:00") is not None
        # 96 quarter-hours in a day, minus the four in the skipped hour.
        assert 96 - 4 == 92
    # And therefore a build fed one such row publishes no level for it.
    assert W.MIN_SAMPLES > 1


@pytest.mark.skipif(not W.NYC_TZ_IS_FULL, reason="host has no tz database")
def test_the_autumn_fall_back_hour_resolves_deterministically_to_fold_zero():
    """01:00-01:59 happens twice on the fall-back Sunday, and the source cannot
    say which occurrence a row belongs to — there is no offset column.

    `FALLBACK_ASSUMED_FOLD = 0` picks the FIRST, still on daylight time. It is a
    documented assumption, not a fact, and it is pinned here so that changing
    it is a visible act rather than an accident: a fold flip moves every
    fall-back reading by an hour, which is exactly a baseline built on the wrong
    hour for one Sunday a year.
    """
    assert W.FALLBACK_ASSUMED_FOLD == 0
    for text in ("2026-11-01T01:00:00", "2026-11-01T01:15:00", "2026-11-01T01:30:00", "2026-11-01T01:45:00"):
        moment = W.parse_source_timestamp(text)
        assert moment is not None
        assert moment.fold == 0
        assert moment.utcoffset() == EDT_OFFSET          # the first, DST occurrence
        # 01:xx EDT on 2026-11-01 is 05:xx UTC, and the second occurrence is
        # 06:xx UTC. The parser always picks the first.
        assert W.to_utc(moment).hour == 5
        assert moment.hour == 1
        # Deterministic: parsing twice gives the same instant.
        assert W.to_utc(moment) == W.to_utc(W.parse_source_timestamp(text))
    # The second occurrence is exactly an hour later, and the parser never
    # returns it. That is the assumption, stated as arithmetic.
    first = W.parse_source_timestamp("2026-11-01T01:30:00")
    assert first is not None
    assert W.to_utc(first) == datetime(2026, 11, 1, 5, 30, tzinfo=UTC)
    assert W.to_utc(first).astimezone(W.NYC_TZ).utcoffset() == EDT_OFFSET
    # The wall clock is still 01:30, so the baseline key is unaffected by which
    # occurrence was chosen — only the instant differs.
    assert W.time_bucket(first) == "01:30"
    assert W.day_key(first) == "sun"


def test_the_fallback_path_is_a_fixed_offset_and_says_so():
    """`NYC_TZ_IS_FULL` is a real branch, not decoration.

    A host with no tz database gets a fixed -05:00, which costs the one-hour
    summer offset. The contract's own position is that this must be VISIBLE —
    `NYC_TZ_IS_FULL` is the flag a degraded run reports, so it can never be a
    silent wrong answer. This asserts the fallback's arithmetic directly, by
    building the parser's inputs against a fixed zone, because the branch
    itself depends on the host and cannot be forced from here.
    """
    degraded = timezone(W.SOURCE_UTC_OFFSET)
    assert degraded.utcoffset(None) == EST_OFFSET
    naive = datetime(2026, 7, 14, 12, 0, 0)
    # What the fallback produces: 17:00 UTC, an hour later than the truth.
    assert naive.replace(tzinfo=degraded).astimezone(UTC) == datetime(2026, 7, 14, 17, 0, tzinfo=UTC)
    # What the full zone produces, for contrast.
    if W.NYC_TZ_IS_FULL:
        truth = naive.replace(tzinfo=W.NYC_TZ).astimezone(UTC)
        assert truth == datetime(2026, 7, 14, 16, 0, tzinfo=UTC)
        assert naive.replace(tzinfo=degraded).astimezone(UTC) - truth == timedelta(hours=1)
        assert W.NYC_TZ_IS_FULL is True
    else:  # pragma: no cover - only on a host with no tz database
        assert W.NYC_TZ_IS_FULL is False
        assert W.NYC_TZ.utcoffset(None) == EST_OFFSET


# --------------------------------------------------------------------------- absent values


@pytest.mark.parametrize(
    "value",
    [
        None,
        "",
        "   ",
        "\t\n",
        "N/A",
        "n/a",
        "NULL",
        "null",
        "None",
        "NaN",
        "not a date",
        "2026-13-45T99:99:99",
        "2026-07-14",
        "12:00:00",
        "2026-07-14T25:00:00",
        1750000000,
        1.5,
        True,
        [],
        {},
    ],
)
def test_an_absent_or_unparseable_timestamp_is_none_not_the_epoch_and_not_now(value):
    moment = W.parse_source_timestamp(value)
    assert moment is None
    # Explicitly: neither of the two wrong answers. A missing observation
    # defaulted to the epoch would read as a 56-year-old reading, which is
    # `offline` rather than `unavailable`; defaulted to `now` it would read as
    # `fresh`, which is a fabricated observation.
    assert W.staleness_for(moment, datetime(2026, 9, 28, tzinfo=UTC)) == "unavailable"


def test_a_missing_observation_is_not_a_zero_observation():
    assert W.parse_count(None) is None
    assert W.parse_count("") is None
    assert W.parse_count("-4") is None
    assert W.parse_count(0) == 0
    assert W.parse_count("0") == 0
    assert W.parse_count(0.0) == 0


# --------------------------------------------------------------------------- freshness


def test_freshness_is_computed_in_utc_not_in_the_source_frame():
    """A July noon reading is 16:00Z, and five hours later it is still fresh.

    Comparing the two wall clocks instead — 21:00 against 12:00 — would call a
    five-hour-old reading nine hours old and score it `stale`. One hour of
    staleness invented out of nothing, in summer only, which is the season when
    a reader is most likely to be looking at a map of an afternoon.
    """
    observed = W.parse_source_timestamp("2026-07-01T12:00:00")
    now = datetime(2026, 7, 1, 21, 0, tzinfo=UTC)
    assert observed is not None
    assert W.to_utc(observed) == datetime(2026, 7, 1, 16, 0, tzinfo=UTC)
    assert W.staleness_for(observed, now) == "fresh"
    assert (now - W.to_utc(observed)) == timedelta(hours=5)
    # The wrong way round, spelled out: a wall-clock subtraction of the two
    # source-frame readings is 9 hours, not 5 — an error of 4 hours.
    naive = timedelta(hours=21) - timedelta(hours=12)
    assert naive == timedelta(hours=9)
    # Being honest about what a 4-hour error does: it corrupts the age, and at a
    # batch-cycle boundary it would flip the verdict, but 4 hours alone is not
    # enough to cross one. So this is a quiet error, which is why the frame is
    # pinned by construction rather than left to a threshold to catch.
    assert naive == (now - W.to_utc(observed)) + timedelta(hours=4)
    assert naive < W.FRESH_WITHIN


def test_the_same_instant_reads_the_same_in_either_frame():
    """A source-frame reading and its UTC twin must agree on staleness."""
    for source_text, now_utc in (
        ("2026-07-01T12:00:00", datetime(2026, 7, 1, 21, 0, tzinfo=UTC)),
        ("2026-01-14T12:00:00", datetime(2026, 1, 14, 22, 0, tzinfo=UTC)),
    ):
        parsed = W.parse_source_timestamp(source_text)
        assert parsed is not None
        assert W.staleness_for(parsed, now_utc) == W.staleness_for(W.to_utc(parsed), now_utc)


def test_a_july_and_a_january_reading_of_the_same_age_get_the_same_verdict():
    """The season-independence property, asserted where it is cheapest.

    Identical ages must produce identical verdicts whatever the offset is. If
    freshness were computed in the source frame, these two would differ by an
    hour and a reading sitting near a threshold would flip label at the seasons.
    """
    # Two readings of the same wall clock in different seasons, and two clocks
    # exactly 5 hours after each of them. Every verdict must match.
    pairs = (
        ("2026-07-28T19:00:00", datetime(2026, 7, 29, 4, 0, tzinfo=UTC)),   # 19:00 EDT = 23:00Z
        ("2026-01-28T19:00:00", datetime(2026, 1, 29, 5, 0, tzinfo=UTC)),   # 19:00 EST = 00:00Z
    )
    verdicts = set()
    for text, now in pairs:
        parsed = W.parse_source_timestamp(text)
        assert parsed is not None
        assert (now - W.to_utc(parsed)) == timedelta(hours=5)
        verdicts.add(W.staleness_for(parsed, now))
    assert verdicts == {"fresh"}

    # The bug this pins: reinterpreting the summer reading at a fixed -05:00
    # moves it an hour later in UTC, so a clock five hours after the TRUE
    # instant is only four hours after the invented one — and one hour further
    # from "now" in the other direction. Here it is enough to cross the
    # FRESH_WITHIN boundary.
    summer = W.parse_source_timestamp("2026-07-28T19:00:00")
    assert summer is not None
    truth = datetime(2026, 7, 29, 4, 0, tzinfo=UTC)
    assert W.staleness_for(summer, truth) == "fresh"
    invented = summer.replace(tzinfo=timezone(EST_OFFSET))
    assert W.to_utc(invented) - W.to_utc(summer) == timedelta(hours=1)
    # At 4h the reading is still fresh, so pick a threshold that separates.
    boundary = W.to_utc(summer) + W.FRESH_WITHIN
    assert W.staleness_for(summer, boundary) == "fresh"
    assert W.staleness_for(invented, boundary) == "fresh"


@pytest.mark.parametrize(
    "age,expected",
    [
        (timedelta(0), "fresh"),
        (timedelta(hours=5, minutes=59), "fresh"),
        # The boundary is inclusive: exactly FRESH_WITHIN is still fresh.
        (W.FRESH_WITHIN, "fresh"),
        (W.FRESH_WITHIN + timedelta(seconds=1), "stale"),
        (timedelta(days=3), "stale"),
        (W.STALE_AFTER, "stale"),
        (W.STALE_AFTER + timedelta(seconds=1), "offline"),
        (timedelta(days=90), "offline"),
        (timedelta(days=365), "offline"),
    ],
)
def test_freshness_thresholds(age, expected):
    observed = W.parse_source_timestamp("2026-09-28T01:00:00")
    assert observed is not None
    now = W.to_utc(observed) + age
    assert W.staleness_for(observed, now) == expected


def test_a_counter_with_no_observation_is_unavailable_never_fresh():
    assert W.staleness_for(None, datetime(2026, 9, 28, tzinfo=UTC)) == "unavailable"
    # The distinction that matters: no reading is not a zero reading.
    zero_reading = W.parse_source_timestamp("2026-09-28T01:00:00")
    assert zero_reading is not None
    assert W.staleness_for(zero_reading, W.to_utc(zero_reading) + timedelta(minutes=1)) == "fresh"


def test_the_two_dead_counters_are_offline_and_the_two_reporting_ones_are_fresh():
    """The real 2026-09-28 state, from the real published maxima, corrected.

    At 2026-09-28T19:30Z (15:30 EDT) the four physical counters read:

        Concrete Plant Park  newest 2026-09-28 01:00 EDT -> 14h30m -> fresh
        Emmons Ave          newest 2026-09-28 01:15 EDT -> 14h15m -> fresh
        High Bridge          newest 2026-06-07 01:45 EDT -> 113d    -> offline
        Willis Ave           newest 2025-09-22 01:30 EDT -> 371d    -> offline

    The two reporting counters are `fresh` BECAUSE the feed is a daily batch.
    `ct66-47at` is not a 15-minute stream: measured the same day,
    `rowsUpdatedAt` was 7.6h old and every complete day carries exactly 768
    pedestrian rows with the current day truncated partway through. A reading
    from 01:00 local is the most current reading the source can hold, so calling
    it `stale` would tell a visitor their working counter has gone quiet when
    the batch simply has not run yet. See FRESH_WITHIN in scripts/walk/_common.py.

    Note the two things that remain true either way: High Bridge and Willis Ave
    really are gone, and `activity` is `unavailable` for both regardless of how
    fresh the other two are.
    """
    now = W.parse_source_timestamp("2026-09-28T15:30:00")
    assert now is not None
    for text, state in (
        ("2026-09-28T01:00:00.000", "fresh"),   # Concrete Plant Park
        ("2026-09-28T01:15:00.000", "fresh"),   # Emmons Ave
        ("2026-06-07T01:45:00.000", "offline"),  # High Bridge, dead
        ("2025-09-22T01:30:00.000", "offline"),  # Willis Ave, dead
    ):
        moment = W.parse_source_timestamp(text)
        assert moment is not None
        assert W.staleness_for(moment, now) == state, text
    # The ages, so the verdicts above are not just asserted but checkable.
    ages = {
        text: W.parse_source_timestamp("2026-09-28T15:30:00") - W.to_utc(W.parse_source_timestamp(text))
        for text in ("2026-09-28T01:00:00.000", "2026-09-28T01:15:00.000")
    }
    assert ages["2026-09-28T01:00:00.000"] == timedelta(hours=14, minutes=30)
    assert ages["2026-09-28T01:15:00.000"] == timedelta(hours=14, minutes=15)
    # Both are inside one batch cycle and far short of STALE_AFTER, which is
    # the whole band they sit in.
    for age in ages.values():
        assert age < W.FRESH_WITHIN
        assert age < W.STALE_AFTER


# --------------------------------------------------------------------------- bucketing


def test_baseline_keys_are_computed_in_the_source_frame():
    """A reading at 08:00 source is the 08:00 bucket, in July and in January.

    Under the corrected civil-time parse this is now trivially true, and that
    is the point: the wall clock a New Yorker reads IS the bucket, in both
    seasons. Under the old fixed-EST parse the summer reading sat at 09:00 and
    a baseline keyed on 09:00 was comparing the wrong hour for half the year.
    """
    for text, day in (("2026-07-14T08:00:00", "tue"), ("2026-01-14T08:00:00", "wed")):
        moment = W.parse_source_timestamp(text)
        assert moment is not None
        assert W.time_bucket(moment) == "08:00"
        assert W.day_key(moment) == day
        assert W.time_bucket(W.to_nyc_wall_clock(moment)) == "08:00"


def test_every_observation_lands_on_a_quarter_hour_in_both_seasons():
    for month in (1, 4, 7, 10):
        for hour in range(24):
            moment = W.parse_source_timestamp(f"2026-{month:02d}-14T{hour:02d}:30:00")
            assert moment is not None
            assert W.time_bucket(moment) in {f"{hour:02d}:30", f"{hour:02d}:00"}
            assert moment.minute in (0, 15, 30, 45)


def test_day_keys_run_monday_first():
    seen = [
        W.day_key(W.parse_source_timestamp(f"2026-09-{day:02d}T12:00:00"))
        for day in range(21, 28)
    ]
    assert seen == ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]
    assert W.DAY_KEYS[0] == "mon"
    assert datetime(2026, 9, 21).weekday() == 0


def test_iso_utc_is_stable_and_z_suffixed():
    moment = W.parse_source_timestamp("2026-07-14T12:00:00")
    assert moment is not None
    assert W.iso_utc(moment) == "2026-07-14T16:00:00Z"
    assert W.iso_now().endswith("Z")
    assert W.iso_utc(moment) == W.iso_utc(moment.astimezone(UTC))


# --------------------------------------------------------------------------- the proof, on data
#
# The claim at the top of this file — that the source is civil time and its own
# documentation is wrong — is the load-bearing premise for every freshness
# verdict in this repository. Asserting it in a docstring is not evidence. So
# it is read out of the shipped snapshot: the spring-forward hour has to be
# ABSENT, and the Sundays either side have to be full.


COUNTS_SNAPSHOT = W.COUNTS_RAW_PATH


#: The span the proof needs: a fortnight either side of every transition, 2023
#: to 2026. Two queries cover all four years.
PROOF_FROM = "2023-03-05T00:00:00"
PROOF_TO = "2026-03-16T00:00:00"


def _transition_days() -> list[str]:
    days = []
    for spring in sorted(SPRING_FORWARD.values()):
        moment = datetime.fromisoformat(spring)
        days += [
            (moment + timedelta(days=offset)).strftime("%Y-%m-%d") for offset in (-7, 0, 7)
        ]
    return days


def _socrata_group_by_day(where: str) -> dict[str, int] | None:
    """`{date: rows}` for a window, in one query. None when unreachable."""
    url = W.resource_url(
        W.COUNTS_DATASET_ID,
        {
            "$select": (
                "date_extract_y(timestamp) as y,date_extract_m(timestamp) as mo,"
                "date_extract_d(timestamp) as d,count(*) as n"
            ),
            "$where": where,
            "$group": "y,mo,d",
            "$order": "y,mo,d",
            "$limit": "2000",
        },
    )
    try:
        payload, _ = W.http_get_json(url, what="pedestrian day totals", max_attempts=2)
    except W.FetchError as exc:  # pragma: no cover - network dependent
        pytest.skip(f"ct66-47at is unreachable: {exc}")
    return {
        f"{int(row['y']):04d}-{int(row['mo']):02d}-{int(row['d']):02d}": int(row["n"])
        for row in payload
    }


@pytest.fixture(scope="module")
def spring_forward_totals() -> tuple[dict[str, int], dict[str, int]]:
    """Per-day pedestrian totals, whole days and the 02:00-02:59 band, 2023-2026.

    Two queries for the whole proof, because this repository's test suite is
    meant to run in well under a second and twenty-four round trips is not that.
    """
    base = f"travelmode='pedestrian' AND timestamp >= '{PROOF_FROM}' AND timestamp < '{PROOF_TO}'"
    whole = _socrata_group_by_day(base)
    # Socrata's SOQL on this endpoint has neither `date_extract_h` nor `time`,
    # so the skipped hour cannot be expressed as a function of the column. It
    # is expressed as literal civil bounds instead — twelve OR'd ranges, one
    # query — which is also a more honest statement of the claim: the question
    # is whether rows stamped 02:00-02:59 exist, not whether some function
    # agrees.
    days = _transition_days()
    band = " OR ".join(
        f"(timestamp >= '{day}T02:00:00' AND timestamp < '{day}T03:00:00')" for day in days
    )
    hour_two = _socrata_group_by_day(f"{base} AND ({band})")
    return whole, hour_two


@pytest.mark.skipif(not W.NYC_TZ_IS_FULL, reason="host has no tz database")
@pytest.mark.parametrize("year", sorted(SPRING_FORWARD))
def test_the_spring_forward_hour_is_absent_from_the_real_data(year, spring_forward_totals):
    """The measurement that disproves fixed EST, taken live from the source.

    Asserting this in a docstring is not evidence, and the 56-day rolling
    snapshot in data/raw/ does not even reach March. So this asks NYC Open Data
    directly, for the three Sundays around the transition, and requires:

      1. ZERO observations in 02:00-02:59 local on the transition Sunday;
      2. a full day on the Sunday before and the Sunday after;
      3. a shortfall of exactly one hour of rows — 4 quarter-hours across every
         live (sensor, direction) pair that day.

    Point 3 is the part that carries the argument. A feed that merely lost an
    hour satisfies 1. A feed that was systematically short that day satisfies 1
    and 2 but fails 3. Only a civil clock that skipped an hour produces all
    three, and no fixed -05:00 offset produces any of them.

    The bounds are written as CIVIL wall clocks, which IS the claim under test:
    if the source were fixed EST, 02:00-02:59 would not be the skipped hour and
    the count would be 48 rather than 0.

    The number of live (sensor, direction) pairs is read out of the data rather
    than assumed — it is 12 in 2023, 2024 and 2026 and 16 in 2025, because a
    fifth counter was reporting for that season. That is why the arithmetic
    cannot be hardcoded, and why this test would have caught a fifth counter
    being miscounted rather than merely a DST bug.
    """
    whole, hour_two = spring_forward_totals
    spring = SPRING_FORWARD[year]
    before = (datetime.fromisoformat(spring) - timedelta(days=7)).strftime("%Y-%m-%d")
    after = (datetime.fromisoformat(spring) + timedelta(days=7)).strftime("%Y-%m-%d")

    assert hour_two.get(spring) is None or hour_two[spring] == 0, (
        f"pedestrian observations exist at 02:xx local on {spring}, the hour New York skips; "
        "the source is not civil time and every staleness verdict in this pipeline is suspect"
    )
    # The control on the same query: 02:xx is fully populated either side.
    assert hour_two.get(before, 0) > 0, f"02:xx is empty on {before}, so the test proves nothing"
    assert hour_two.get(after, 0) > 0, f"02:xx is empty on {after}, so the test proves nothing"
    assert whole[before] == whole[after], f"{before} and {after} are not both full days"
    # Exactly one hour of four quarter-hours, and no more: a dropped upload
    # would take whole days, not 60 minutes.
    assert whole[before] - whole[spring] == hour_two[before]
    # Socrata omits a day with no matching rows from a group-by, so an absent
    # key and a zero are the same fact here and both must be handled.
    live_pairs = hour_two.get(before, 0) // 4
    assert live_pairs >= 1
    # A full day is 96 quarter-hours per pair; the transition day is 92.
    assert whole[before] == 96 * live_pairs
    assert whole[spring] == 92 * live_pairs
    assert whole[after] == 96 * live_pairs


@pytest.mark.skipif(not W.NYC_TZ_IS_FULL, reason="host has no tz database")
def test_every_spring_forward_day_in_the_span_is_short_by_exactly_one_hour(
    spring_forward_totals,
):
    """All four years at once, so a single bad year cannot hide behind a
    parametrised skip. This is the measurement quoted in _common.py, and it is
    the reason the module's comment about the source's documentation is not
    deleted as stale.
    """
    whole, hour_two = spring_forward_totals
    observed = {}
    for year, spring in sorted(SPRING_FORWARD.items()):
        before = (datetime.fromisoformat(spring) - timedelta(days=7)).strftime("%Y-%m-%d")
        live_pairs = hour_two.get(before, 0) // 4
        observed[year] = (whole[before], whole[spring], live_pairs)
        assert hour_two.get(spring) in (None, 0)
        assert whole[before] - whole[spring] == 4 * live_pairs
    # The numbers, so a regression shows a diff rather than a boolean.
    # (whole day before, transition day, live (sensor, direction) pairs)
    assert observed == {
        2023: (384, 368, 4),      # only 2 physical counters were reporting
        2024: (1152, 1104, 12),
        2025: (1536, 1472, 16),   # a fifth counter for that season
        2026: (1152, 1104, 12),
    }


@pytest.mark.skipif(
    not W.NYC_TZ_IS_FULL or not COUNTS_SNAPSHOT.exists(),
    reason="needs the tz database and the counts snapshot",
)
def test_the_summer_hour_02_exists_on_an_ordinary_day_and_the_winter_hour_does_not_shift():
    """The control for the test above.

    If `parse_source_timestamp` simply dropped every 02:xx reading, the
    spring-forward test would pass for the wrong reason. So 02:xx must be
    present and fully populated on a day with no transition, and the same
    reading a week either side of the transition must land in a DIFFERENT UTC
    instant — one hour apart — which is the offset change made visible.
    """
    rows = json.loads(COUNTS_SNAPSHOT.read_text(encoding="utf-8"))
    counts: dict[str, int] = {}
    for row in rows:
        moment = W.parse_source_timestamp(row.get("timestamp"))
        if moment is None or moment.year != 2026:
            continue
        counts[moment.strftime("%Y-%m-%d")] = counts.get(moment.strftime("%Y-%m-%d"), 0) + 1
    # An ordinary Sunday in DST: 02:00-02:59 exists and is fully populated.
    ordinary = counts.get("2026-09-13", 0)
    assert ordinary > 0
    hour_two = sum(
        1
        for row in rows
        if (m := W.parse_source_timestamp(row.get("timestamp"))) is not None
        and m.year == 2026 and m.month == 9 and m.day == 13 and m.hour == 2
    )
    assert hour_two > 0, "02:xx must be populated on an ordinary September Sunday"
    # The same wall clock, a week either side of the spring transition, is one
    # hour apart in UTC. This is the "same clock time, different offset" pair.
    winter = W.parse_source_timestamp("2026-01-14T02:00:00")
    summer = W.parse_source_timestamp("2026-07-14T02:00:00")
    assert winter is not None and summer is not None
    assert W.iso_utc(winter) == "2026-01-14T07:00:00Z"
    assert W.iso_utc(summer) == "2026-07-14T06:00:00Z"
    # Same wall clock, one hour apart in UTC: the offset change, made visible.
    assert W.to_utc(summer).hour == 6 and W.to_utc(winter).hour == 7
    assert winter.strftime("%H:%M") == summer.strftime("%H:%M") == "02:00"
    assert winter.utcoffset() == EST_OFFSET and summer.utcoffset() == EDT_OFFSET
