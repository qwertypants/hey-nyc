# Where NYC Walks — methodology

What a label on this map means, how it is derived, and what it cannot tell you.
Every number here was measured against the live NYC Open Data endpoints or
against the committed snapshot on **2026-09-28**; the queries are in
[`walk-data-analysis.md`](walk-data-analysis.md), and the decisions are
[ADR 0006](adr/0006-lead-with-the-bi-annual-counts-not-the-live-feed.md).

Read the limitations section last, and read it properly. This feature publishes
fewer things than it might appear to, on purpose.

- [Two programs, not one](#two-programs-not-one)
- [Sources](#sources)
- [Coverage](#coverage)
- [What a sensor reading is](#what-a-sensor-reading-is)
- [In, out, and the twins](#in-out-and-the-twins)
- [The bi-annual survey model](#the-bi-annual-survey-model)
- [Activity labels](#activity-labels)
- [The zero-median rule](#the-zero-median-rule)
- [Freshness](#freshness)
- [Missing data is not zero](#missing-data-is-not-zero)
- [Timestamps](#timestamps)
- [What the two programs share](#what-the-two-programs-share)
- [The refresh](#the-refresh)
- [Limitations](#limitations)
- [Where the numbers come from](#where-the-numbers-come-from)

## Two programs, not one

"Where NYC Walks" is built on **two separate measurement programs** run by NYC
DOT, and the single most important thing to know about them is that they do not
measure the same thing, in the same unit, at the same times, on the same
streets. They are never summed, never joined, and never shown on one scale.

| | Automated counters | Bi-annual screenline counts |
| --- | --- | --- |
| Published as | `sensors.geojson`, `latest.json` | `historical-locations.geojson`, `historical-patterns.json` |
| Locations | **4 physical counters** | **114 locations** |
| What it is | An automated counter, folded to in + out every 15 minutes | A manual two-hour screenline count, morning / midday / evening |
| Unit | people per 15 minutes | people per survey period |
| Cadence | a daily batch, hours behind | 2–3 discrete surveys a year |
| Span | 2022 → 2026 (per counter) | 2007 → 2026 |
| Labels | `quiet` / `typical` / `busy` / `veryBusy`, relative to the counter's own recent history | `rising` / `falling` / `flat`, first survey to most recent |
| Role | secondary layer, honestly stale | **the primary layer** |

The historical program is the one with coverage, and the automated program is
the one that moves. That is the opposite of what this feature was planned to be,
and [ADR 0006](adr/0006-lead-with-the-bi-annual-counts-not-the-live-feed.md)
records the inversion and what it cost.

## Sources

Three NYC Open Data datasets, all Socrata v2.1, all readable without a key.

| | Counts | Sensor metadata | Historical counts |
| --- | --- | --- | --- |
| Dataset | `ct66-47at` | `6up2-gnw8` | `cqsj-cfgu` |
| Name | Bicycle and Pedestrian Counts | Bicycle and Pedestrian Count Sensors | Bi-Annual Pedestrian Counts |
| Rows | 21 269 650 | 67 | 114 |
| Columns | 9 | 16 | 119, of which 111 are counts |

**`ct66-47at` is 93% bicycle.** Pedestrian is 1 505 220 rows — 7.1% — against
19 738 684 bike and 25 746 scooter. Every fetch filters
`travelmode='pedestrian'` server-side and `$select`s only the nine columns the
build reads, so bike rows never cross the wire.

The nine count columns are `sensor_id`, `travelmode`, `direction`, `flowid`,
`flowname`, `timestamp`, `granularity`, `counts`, `status`.

- **`direction`** is `in` or `out` — two separately counted directions of the
  same sidewalk.
- **`counts`** is the count for that 15-minute interval. A genuine `0` is a
  measurement. An absent row is not (see
  [missing data](#missing-data-is-not-zero)).
- **`status`** and **`granularity`** are useless here: `status` is `raw` for all
  1 505 220 pedestrian rows and `granularity` is `PT15M` for all of them. The
  vocabulary is real — bike rows do use `modified` — but for pedestrians the
  fields are constant, so neither is published as a health signal and neither
  is a filter. A one-value filter is a lie.
- **`flowname`** is not a join key and not safe to display: it is null for
  600 916 pedestrian rows (39.9%), and the nulls are systematic, because DOT
  backfilled the flow names on 2025-12-01. The counter's `name` comes from
  `6up2-gnw8` instead.
- **`flowid`** is a *flow* identifier, not a row identifier. There are 16 of
  them across 1.5M rows (8 sensors × 2 directions). The deduplication key is
  `(sensor_id, timestamp, direction)`, and against that key the pedestrian data
  is clean — zero duplicates.

`6up2-gnw8` is one row per sensor id, with the `travelmodes` list, the
`counters_serial`, the position, the installation and detachment dates, and a
`lastdata` field. It publishes **no borough column**, so the borough on a
counter is derived by point-in-polygon against Borough Boundaries
(`gthc-hcne`) and is a derivation, not a source value.

## Coverage

**Four physical counters, citywide.** `6up2-gnw8` has 67 rows and 42 distinct
`id` values, and it also has 43 distinct `counters_serial` values — more serials
than ids, which is the first hint of [the twin problem](#in-out-and-the-twins).
Grouped by declared mode, the 42 ids resolve as:

| `travelmodes` | ids |
| --- | --- |
| `bike` | 33 |
| `bike, pedestrian` | 4 |
| `pedestrian` | 4 |
| `bike, scooter` | 1 |

Pedestrian coverage is therefore **8 sensor rows**, which are **4 counters
published twice each**:

| Counter | `counters_serial` | source `sensor_id`s | Borough | Newest reading | State at the last build |
| --- | --- | --- | --- | --- | --- |
| Concrete Plant Park | YAH22104563 | 300040736, 300043073 | Bronx | 2026-09-28 05:00Z | `stale`, reporting zeros for 45 days |
| Emmons Ave | YAH22104564 | 300038509, 300043075 | Brooklyn | 2026-09-28 05:15Z | `stale`, last non-zero 2026-09-27 |
| High Bridge | YAH22104566 | 300038506, 300043077 | Manhattan | 2026-06-07 | `offline` (113 days) |
| Willis Ave | YAH22104565 **and** YAH18055368 | 300028963, 300029648 | Bronx | 2025-09-22 | `offline` (371 days) |

Two things in that table are worth stating plainly. There is **no counter in
Queens or Staten Island**, so this layer cannot be compared by borough. And
**one of the four has been publishing a row every 15 minutes with every reading
`0` for 45 days** — a freshness check based on the newest row alone calls that
counter healthy minutes after a row lands, because it *is* landing on schedule.
A row is not a measurement.

**114 screenline locations, 2007 → 2026.** The historical program is on retail
corridors plus the East River and Harlem River bridges and the Hudson River
Greenway — the Williamsburg, Queensboro, Broadway, University Heights, Macombs
Dam, 145th Street, Madison Avenue, Third Avenue, Willis Avenue and Triborough
bridges, and the Greenway at 50th–51st Street. **50 of the 114 are in the
Pedestrian Volume Index**, the count DOT uses for the Mayor's Management Report.
Every location has been surveyed at least once; the dataset is 97.3% complete
(12 312 of 12 654 count cells), and `may26_pm` — the newest survey — has 113 of
114 populated.

## What a sensor reading is

One number per counter per 15 minutes: **the sum of the counter's `in` and
`out` flows for that interval**, for one physical counter, in New York civil
time.

Everything in that sentence is load-bearing.

- **15 minutes.** `granularity` is `PT15M` on every pedestrian row. An interval
  is a count of people who crossed the sensor's line during those 15 minutes,
  not a snapshot of how many people were standing there.
- **`in` + `out`.** The sensor splits one sidewalk into two counted directions.
  A person walking north and a person walking south both cross it, and a
  screenline that counted only one direction would be describing half a street.
- **One physical counter.** Not one sensor id. See below.
- **Civil time.** Not UTC, and not fixed EST. See [timestamps](#timestamps).

The published `count` is that sum for the newest interval. `observedAt` is when
it was counted, in UTC, and it is the field any "how fresh is this" statement
must be computed from — **not** the build time.

## In, out, and the twins

Each of the four physical counters is published by the source under **two**
`sensor_id` values: one row tagged `bike, pedestrian` and one tagged
`pedestrian`. They share a `counters_serial`, they share byte-identical
coordinates, and they carry a **byte-identical count series** — verified by
downloading both series for two counters and comparing the
`(timestamp, direction) → counts` maps.

So:

- **Summing `direction` is correct.** The two rows are genuinely separate
  counted flows. The pedestrian split is exactly even — 752 610 `in`, 752 610
  `out` — which is what a screenline looks like.
- **Summing `sensor_id` is exactly 2× wrong.** The eight per-sensor totals come
  to **7 484 824**; the physical figure is **3 742 412**. Joining counts to
  sensors on `sensor_id` and aggregating by location doubles the city's entire
  measured pedestrian volume, silently, and produces a map that is wrong by
  precisely a factor of two and looks entirely plausible.

The published id is therefore keyed on the **physical counter**, not on the
source id: `wsk-` + `sha1(counters_serial)[:12]`. Resolution takes **two
passes**, and both are needed:

1. **Group on `counters_serial`.** This collapses the `bike, pedestrian` /
   `pedestrian` id pairs.
2. **Merge groups that are the same site.** Willis Avenue publishes one series
   under **two** serials — `YAH18055368`, a 2018 unit, and `YAH22104565`, its
   2021 replacement — and both carry both of that site's ids. A single-pass
   grouping returns Willis twice, at the same coordinates with the same counts:
   the same doubling, wearing a different hat. The merged group keeps the
   lexicographically greatest serial and records the other in
   `counterSerialAliases`.

Then **one** representative source id per counter is summed, in + out. The
source ids stay in `sensorIds` so the join back to the city's own data is still
one lookup away.

The validator asserts four twin invariants, so this cannot rot silently:

| | Invariant |
| --- | --- |
| I1 | no two published features share a `counterSerial` |
| I2 | every source `sensor_id` appears in exactly one feature's `sensorIds` |
| I3 | each `count` equals the in + out sum recomputed from the raw rows of that feature's representative id |
| I4 | the twin-unaware aggregate equals `count × len(sensorIds)` — the twins are identical duplicates and the published total is not 2× it |

I3 and I4 are the same measurement from both sides. I3 fails if the build
summed the wrong series; I4 fails if the twins ever diverge.

## The bi-annual survey model

The historical program is **not** a time series. It is a list of discrete
screenline surveys, two or three a year, and nothing at all was measured between
them. There is no interpolation anywhere in this feature, and a `null` period is
a period that was never counted — not a zero.

111 count columns is **37 surveys × 3 periods**: May appears 18 times (2007–2019,
then 2021–2023 and 2025–2026), September 12 (2007–2018), October 6 (2020–2025)
and June once (2024). The calendar is not regular, and the irregularities are
published rather than smoothed over:

| Period | Surveys | Note |
| --- | --- | --- |
| May + September | 2007 → 2018 | two a year, 24 surveys |
| **May 2019 only** | 1 | no `sept_19_*` column exists. May 2019 exists and is **partial — 50 of 114 locations** |
| **October 2020 only** | 1 | no `may_20_*` column exists |
| May + October | 2021, 2022, 2023 | 6 surveys; September gives way to October |
| **June + October** | 2024 | 2 surveys; counted in **June**, not May |
| May + October | 2025 | 2 surveys |
| May 2026 | 1 | newest |

`loc 26` (Jay Street, Brooklyn) has dropped out of every survey since June 2024.
`loc 113` (Triborough Bridge) dropped out from June 2024 to October 2025 and
returned in May 2026.

**`change` and `trend` are deliberately narrow.** A site's `change` is computed
only when the first and last surveys of the comparison share a calendar month,
both have all three periods populated, and the span is at least 5 years. The
comparison month is the month of the site's **first complete** survey — not
whichever month maximises the gap, because choosing that would manufacture a
trend out of seasonal noise. `flat` is a band of ±15% of the first survey's
total, derived from the measured year-over-year wobble across 3 421 adjacent
same-month survey pairs (median 13.1%, 75th percentile 27.1%) — a hand-counted
two-hour sample is noisy, and a tighter band would label sampling noise as a
direction of travel.

Everything else publishes as `null`, and `trend` reads `change` and nothing
else, so the two cannot disagree. On the current snapshot that yields **41
rising, 41 falling, 32 flat, 0 insufficient** across all 114 sites.

**The column spellings are a trap and are handled explicitly.** The source spells
those 111 columns three ways in the same row:

| Spelling | Columns | Example |
| --- | --- | --- |
| `month_YY_period` | 97 | `may_07_am`, `june_24_md` |
| `monthYY_period` | 12 | `oct24_am`, `may26_pm` |
| `month_YY_p_m` | 2 | `may_22_p_m`, `may_23_p_m` |

The last spelling is not a new period. Those two columns are labelled `May22_pM`
and `May23_pM` by DOT — the `PM` got split into a `p` and an `m` — and they hold
real data: 112 locations each. A parser that understands only the first two
spellings silently drops **224 populated observations**. All 111 are consumed
and the third maps onto `pm`. A separate, deliberately broader *shape* detector
then asserts that every survey-shaped column was consumed, so a **fourth**
spelling shows up as an error rather than as data loss.

**`borough` is not a borough column.** 19 of 114 sites carry a waterway name —
`Harlem River Bridges` (9) and `East River Bridges` (5) — and 5 carry the
truncated **`Staten Isla`**, which is how the source spells it on all five
Staten Island sites. The value is published **verbatim**, counted in
`report.pipeline.nonBoroughBoroughValues`, and warned about by the validator.
Rejecting would drop 19 real hand-counted bridge sites over a naming problem,
and "repairing" it would need a bridge-to-borough table the city never
published, so every row of it would be a guess wearing a citation. Nothing keys
on the literal string of a known-odd value, so a future correction publishes
cleanly and the counter simply moves.

## Activity labels

A label describes **one counter, right now, against its own recent history at
the same weekday and time of day**. It is not a comparison with the city, with
another counter, or with the screenline layer.

### The baseline

- A trailing **56-day** window — eight weeks.
- Keyed on **(weekday, 15-minute bucket)** in New York civil time, so "typical at
  08:00" means typical at 08:00 on the clock a New Yorker would read.
- The **current observation is excluded** from its own baseline. Including it
  would put the point being measured inside the distribution it is scored
  against, which flatters every counter by one sample.
- `expected` is the **median** of that key's history, rounded half up. `p25`,
  `p75` and `p90` are computed and live in the report; the published contract
  has no field for them.

**Why the window rolls.** Weekly pedestrian volume on these corridors is
seasonal, and the swing is the same order of magnitude as anything else you
might want to say: September runs **1.5× to 2.7× January** at the same weekday
and the same time of day (Concrete Plant Park 2.00×, High Bridge 2.67×, Willis
Ave 1.53×, Emmons Ave 1.50×). An all-time baseline would compare a September
afternoon against a January afternoon forever. A rolling window is the only
version of this computation that is honest, and it is also the only one that
**recovers**: a counter fault from last month leaves the baseline next month,
which an all-time baseline never does.

**Why 56 days and not longer.** Measured against a disjoint ground truth — each
observation scored against the *following* weeks, on buckets where the number
means something — the median absolute error is **flat across a six-fold change
in window**: 4 weeks and 26 weeks are indistinguishable (p50 error 3.0–5.0, p90
error 4.0–6.6 people per 15 minutes). The binding constraint is the intrinsic
week-to-week variance of a sidewalk, not the sample count. A longer window does
not make the baseline more truthful; it makes it slower to notice autumn.

### The percentile

The score is where the reading sits in its own bucket's history:

```
percentile = 100 × (observations below + half the observations tied) / n
```

A reading equal to the median scores 50 rather than an arbitrary point inside
the tie block. The published `percentile` is `null` when there is no history to
compare.

### `MIN_SAMPLES` is 7

A baseline of fewer than 7 observations is `unavailable` rather than a guess.
Seven is not a round number and it is not the 4 this started at:

- **It is the observed floor.** An eight-week window gives 8 observations for
  1 227 of the 1 344 baseline keys in the committed snapshot, and exactly 7 for
  the other 117, where the window boundary lands mid-day. Gating at 7 costs a
  healthy refresh nothing.
- **It clears the tie-credit arithmetic.** `percentile_rank` credits half the
  ties, so the highest percentile any observation can attain against `n` samples
  is `100 − 50/n`:

  | n | top attainable rank | `veryBusy` (≥ 90) |
  | --- | --- | --- |
  | 4 | 87.50 | **unreachable** |
  | 5 | 90.00 | reachable |
  | 7 | 92.86 | reachable |
  | 8 | 93.75 | reachable |

  At `MIN_SAMPLES = 4`, `veryBusy` was **structurally impossible** — not rare,
  impossible — and the label silently degraded to "new record". Do not lower
  this without redoing that arithmetic.

### The thresholds

| Label | Condition |
| --- | --- |
| `veryBusy` | percentile ≥ 90 |
| `busy` | 75 ≤ percentile < 90 |
| `typical` | 25 ≤ percentile < 75 |
| `quiet` | percentile < 25 |
| `unavailable` | no baseline, or the [zero-median rule](#the-zero-median-rule) applies |

`unavailable` is a **state, not a level of activity**, and no percentile cut
ever produces it. It means "we can tell you the number and not the level".

`ratio` is published beside the label — `count / expected`, rounded to three
decimals, and `null` where `expected` is 0 — for anyone who wants the
magnitude. It is never used to compute the label, and it is never comparable
between counters: the per-15-minute medians at the four counters are 1, 2, 3
and 16, because they count different physical things at different scales.

## The zero-median rule

**61.1%** of the 10 635 complete in + out intervals in the committed 56-day
snapshot are exactly `0`, **60.6%** of the 1 344 baseline keys have a median of
exactly `0`, and **348** of those keys are zero in every one of their samples.
Zero-dominated buckets are the majority case, not an edge case.

That is not a curiosity — it breaks the ladder, because a rank carries no
information about how much activity a bucket has ever contained. In a bucket
whose median is zero, a genuine zero — an empty park path at 1am — sits around
the 30th percentile, inside `typical`. **An empty street at 1am would read
"typical"**, and "typical" is the one label that is not actionable.

So a bucket whose published `expected` is `0` never reaches the ladder:

| Condition | Label |
| --- | --- |
| `expected == 0` and `count == 0` | **`quiet`** — the bucket is empty and expects to be empty |
| `expected == 0` and `count > 0` | **`unavailable`** — the measurement is published, the level is not |

The second row is the important one. A blip of 5 people against seven
identically-zero historical samples scores `100 − 50/n` — the **maximum** the
tie-credit formula can return — so the ladder would publish `veryBusy`, the
strongest claim available, out of a distribution with zero variance and no upper
support.

The honest consequence: between midnight and 06:00 the automated layer is largely
`quiet` or `unavailable`, and that is the truth. Those are the hours this data
can say almost nothing about, and a confident "typical" would be a worse answer
than an honest blank.

## Freshness

`staleness` is **derived**, never taken from a source column.

| State | Condition on the newest observation |
| --- | --- |
| `fresh` | at most 6 hours old |
| `stale` | more than 6 hours, at most 24 hours old |
| `offline` | more than 24 hours old |
| `unavailable` | there is no observation to measure |

`active` is true only when `staleness` is `fresh`.

Why derived: `status` is `raw` for **all 1 505 220 pedestrian rows**, so it cannot
distinguish a counter carrying a crowd from one carrying nothing at all, and
publishing it as a health signal would be a confident wrong answer derived from
a real column. `lastdata` in the sensor metadata is no better: it is **100 days
stale** for both Willis Avenue rows, which would ship a counter dead for a year
as "live until 2025-12-31". First and last observation are derived from the
counts, and for a counter that has stopped reporting entirely the window has no
rows at all, so an 8-row extent probe supplies the dates.

One thing to know about these thresholds: they are **generous on purpose**. A
false "no recent reading" on a live counter is a lie about the data, which is
the one thing this feature must never tell. The cost is that they are also
slow — at the last build all four counters were past the 6-hour window and two
of them were 113 and 371 days past, and the practical result is that
`activePedestrianCounters` is frequently 0.

> **Known rough edge.** `_common.py` also declares `OFFLINE_AFTER = 30 days`,
> which is **not** wired into `staleness_for`. The shipped behaviour is
> `fresh`/`stale`/`offline` at 6 h / 24 h / 24 h. The constant should either be
> used or removed; it is not a fourth state.

The other known gap is a fault gate. Concrete Plant Park is publishing a row
every 15 minutes, all of them `0`, and the label it gets is `quiet` — the honest
floor, but not the right answer for a dead sensor. `status` will not catch it,
`granularity` will not catch it, and neither will the freshness check. The
all-zero-run detector and the trailing `|in − out| / (in + out)` ratio the
analysis recommends would, and neither is implemented yet. See the open
questions in
[`walk-data-analysis.md`](walk-data-analysis.md#open-questions-for-the-maintainer).

## Missing data is not zero

Socrata omits an absent observation entirely, so there is no `null` row to
confuse with a measurement: **a gap in the 15-minute grid is missing, and a
present row is a measurement.** The pipeline's `parse_count` returns `None` for
absent and never for zero, and every consumer handles it explicitly.

Within each counter's own span the grid is 99.99% complete. The only missing
slots per year are the four DST quarter-hours described below, and the only two
`null` `counts` values in the entire pedestrian dataset are two rows at Emmons
Ave on 2025-05-28.

The consequence for the UI is not optional: **a missing measurement is never
rendered as "quiet".** `unavailable` is the answer when there is no reading, and
`count` is `null` on an offline counter — which the validator treats as a
corruption if it ever appears alongside an `offline` state.

The historical half has the same rule from the other direction. A `null` period
is a period that was never surveyed. `0` is rarer there — 12 zero cells out of
12 312 populated, none in any recent survey — and even then, `0` may mean "the
count was never taken", so it is never treated as absent.

## Timestamps

**The source documentation is wrong and the data is right.** DOT's dataset
description says *"Time is captured in EST time zone."* These are
**America/New_York civil timestamps**: −05:00 in winter, −04:00 in summer. The
pipeline localises with `America/New_York` and never applies a second offset.

The proof is the spring-forward hour. New York civil time skips 02:00–02:59 on
the second Sunday of March, and that window has **zero rows on that date in
every year from 2013 to 2026**, while the Sundays either side are complete:

| Year | spring-forward day | previous Sunday | next Sunday |
| --- | --- | --- | --- |
| 2023 | 368 | 384 | 384 |
| 2024 | 1104 | 1152 | 1152 |
| 2025 | 1472 | 1536 | 1536 |
| 2026 | 1104 | 1152 | 1152 |

Each is short by exactly 48 rows — one hour of four quarter-hours across twelve
live (sensor, direction) pairs. **A fixed −05:00 offset cannot produce a missing
hour**; under it those quarter-hours exist every day of the year.

Getting this wrong is not cosmetic:

- **Every time-of-day baseline shifts for half the year.** A 17:00 observation
  would be bucketed as 17:00 in January and 17:00 in July, an hour apart in real
  behaviour.
- **Freshness is biased.** A summer reading scored an hour staler than it is,
  which with a 6-hour `fresh` window is not a rounding error — it moves readings
  across the boundary once a day for seven months.

**The autumn hour is lost and cannot be recovered.** If the label is civil time,
then 01:00–01:45 occurs twice on the first Sunday in November. The dataset has 96
distinct labels that day and no duplicate rows, so the ETL collapsed the
repeated hour: **one physical hour of counts is absent, once a year, on every
sensor**, and the published data cannot say which of the two occurrences
survived. The pipeline resolves the ambiguous label to the first occurrence and
documents it as an assumption rather than a fact.

If the host has no tz database the pipeline falls back to −05:00 and says so in
the report — a degraded run is visible rather than silent.

## What the two programs share

Almost nothing, and the list is worth keeping explicit:

- **No shared unit.** A 15-minute bidirectional count and a two-hour AM/MD/PM
  screenline total are different quantities. Nothing converts one to the other.
- **No co-located pair.** The nearest automated counter to any screenline is
  **624 m** apart and **not one pair is co-located**. The nearest pair of
  automated counters to each other is 3 993 m; the furthest is 28 648 m.
- **No shared scale.** The per-15-minute medians at the four counters differ 8×,
  because they count different physical things.
- **No shared label vocabulary.** A `busy` screenline and a `busy` counter are
  two different words.

So: no interpolating between them, no normalising against one another, no shared
legend without saying which is which, and no number that adds one to the other.

## The refresh

[`refresh-walk-data.yml`](../.github/workflows/refresh-walk-data.yml) runs
**daily**, and can be triggered by hand. It:

1. restores the raw snapshot cache, keyed on the pipeline code;
2. fetches — the incremental pedestrian window, the 67 sensor rows, and the
   114-row historical snapshot;
3. builds and validates both halves;
4. asks one question: **did the published records change?** (a `contentHash`
   comparison, plus a timestamp-stripped cross-check, per
   [ADR 0002](adr/0002-hash-features-never-the-timestamp.md));
5. commits and pushes only if they did.

**Daily, not every six hours.** `ct66-47at` is a daily batch with a multi-hour
ingestion lag: when it was measured, `rowsUpdatedAt` was **7.6 hours old** and
the newest pedestrian row was **14.6 hours old**, while 55 of the 57 days in the
snapshot carried exactly 768 pedestrian rows and the current day was truncated
at 01:15. A six-hourly schedule would mostly re-fetch byte-identical data. It is
refreshed as often as the source publishes, and the UI shows the age of the
newest observation rather than the word "live".

Two operational notes, both visible in the workflow:

- The fetch budgets its window **before** requesting it and **refuses** rather
  than truncating. 768 rows a day means a 56-day window is 43 008 rows against
  a ceiling of 43 000 — deliberately below Socrata's own 43 043, because a
  ceiling you can hit is a ceiling that truncates. It passes today only because
  the feed is hours behind; if the feed ever becomes current, a first run on a
  fresh checkout is refused with `--baseline-window 55` as the documented fix.
- The commit gate is **hash-based, never mtime-based**, which has one known
  blind spot: the historical hash covers `historical-locations.geojson` only, so
  a fix to an older survey column that no site's *latest* survey depends on
  changes `historical-patterns.json` without moving the hash. The
  timestamp-stripped comparison is what catches that case.

## Limitations

Read this section before relying on any of it.

- **It cannot say where to walk.** The automated program has ever measured four
  locations and currently produces data at one of them. A map of where to walk
  needs a network; this is four points. The "no recommendations" rule in
  [`contributing.md`](contributing.md#what-not-to-add) already forbids it, and
  the coverage is a second, independent reason.
- **It cannot interpolate to unmeasured streets.** The nearest automated counter
  to any screenline is 624 m and no pair is co-located. Between any two counters
  there is nothing but the basemap. A heat surface, an isochrone, a walkability
  fill, a shade between two dots — each of those is a picture of the
  interpolation, not of the data.
- **It cannot compare boroughs.** Two counters in the Bronx, one in Brooklyn, one
  in Manhattan, none in Queens or Staten Island — and the historical
  `borough` column is not a borough column at all.
- **It cannot compare the four counters to each other.** Different places,
  different scales, 3 993 m to 28 648 m apart. Nothing in the data says Emmons
  Avenue is busier than Concrete Plant Park.
- **It cannot tell you what a street feels like.** A count is a magnitude. No
  direction of travel beyond the sensor's own in/out split, no speed, no dwell,
  no lighting, no crossings, no seating, no accessibility. A "quiet" street and
  an "empty" street are the same measurement and are not the same place.
- **It cannot say anything about a time of day it has no baseline for** — which
  is most of the night.
- **The screenline half is a survey, not a series.** Between two surveys, this
  feature knows nothing. "Busy in May 2026" and "busy now" are different claims
  and the data on screen is always dated.
- **The "live" layer is a daily batch that was 14.6 hours behind when it was
  last measured**, and two of its four counters have not reported in over three
  months. If the automated layer does not recover, the honest move is to delete
  it — see [ADR 0006](adr/0006-lead-with-the-bi-annual-counts-not-the-live-feed.md).
- **No trend is a measurement of the street changing.** It is a comparison
  between two hand counts, subject to the same noise, and it is null whenever
  the comparison would be season-mismatched.

## Where the numbers come from

| Document | What it holds |
| --- | --- |
| [`walk-data-analysis.md`](walk-data-analysis.md) | Every measurement, with the query that produced it, plus the open questions |
| [`adr/0006`](adr/0006-lead-with-the-bi-annual-counts-not-the-live-feed.md) | Why the historical program leads, what was rejected, when to revisit |
| [`data-pipeline.md`](data-pipeline.md) | The runbook for the Dining Out pipeline; the walk half has its own scripts |
| [`decisions.md`](decisions.md) | The decision index |
| [`src/types/walk.ts`](../src/types/walk.ts) | The published contract, on both sides of the language boundary |
| `data/processed/walk/report.json` | Per-refresh counters: rejections, pipeline anomalies, trends, hashes |
