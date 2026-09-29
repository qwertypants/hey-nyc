# Where NYC Walks — data analysis

**Every number in this document was measured against the live NYC Open Data
endpoints on 2026-09-28.** Each one has the query that produced it. Nothing
here is inherited from a plan, a brief, or the data dictionary of another
dataset.

The short version: **the automated pedestrian program covers four physical
counters, one of which is currently reporting zeros, and the historical program
covers 114 locations.** The plan assumed the reverse. This document is the
evidence for the product direction that followed from finding that out.

- [Purpose](#purpose)
- [Sources](#sources)
- [Coverage: four counters, not sixty-seven](#coverage-four-counters-not-sixty-seven)
- [The duplicate-counter trap](#the-duplicate-counter-trap)
- [Timestamp semantics](#timestamp-semantics)
- [The historical dataset and its three column spellings](#the-historical-dataset-and-its-three-column-spellings)
- [Survey calendar and coverage gaps](#survey-calendar-and-coverage-gaps)
- [Sample-size arithmetic](#sample-size-arithmetic)
- [Distributions and outliers](#distributions-and-outliers)
- [Thresholds: what the data supports](#thresholds-what-the-data-supports)
- [Missing data and the missing-is-not-zero rule](#missing-data-and-the-missing-is-not-zero-rule)
- [Anomalies and drift risks](#anomalies-and-drift-risks)
- [What this data cannot support](#what-this-data-cannot-support)
- [Open questions for the maintainer](#open-questions-for-the-maintainer)

## Purpose

This is the evidence record for the "Where NYC Walks" feature. It answers three
questions and refuses to answer the rest:

1. What is actually in the three candidate datasets.
2. What can be computed from them without inventing something.
3. What they cannot be made to say, however hard the schema is stretched.

It is a data document, not a decision record. The decisions it feeds are ADRs
in [`adr/`](adr/), indexed from [`decisions.md`](decisions.md). It does not
restate the rules from [`contributing.md`](contributing.md); it links to them.

Read it alongside [`data-dictionary.md`](data-dictionary.md), which does the
same job for `fpeh-f7ci`, and [`data-pipeline.md`](data-pipeline.md), which is
how the other pipeline is operated.

## Sources

Three datasets, all NYC Open Data, all Socrata v2.1, none requiring a key.

| | Automated counts | Sensor metadata | Historical counts |
| --- | --- | --- | --- |
| Dataset | `ct66-47at` | `6up2-gnw8` | `cqsj-cfgu` |
| Name | Bicycle and Pedestrian Counts | Bicycle and Pedestrian Count Sensors | Bi-Annual Pedestrian Counts |
| Rows | **21 269 650** | **67** | **114** |
| Columns | 9 | 16 | 119 |
| Method | automated counter, 15 min | one row per sensor id | manual screenline, AM/MD/PM |
| Span | 2012-08-31 → 2026-09-28 | — | 2007 → 2026 |

```sql
-- ct66-47at
$ curl -sG https://data.cityofnewyork.us/resource/ct66-47at.json \
    --data-urlencode '$select=count(*) as n'
[{"n":"21269650"}]

-- 6up2-gnw8
$ curl -sG https://data.cityofnewyork.us/resource/6up2-gnw8.json \
    --data-urlencode '$select=count(*) as n'
[{"n":"67"}]

-- cqsj-cfgu
$ curl -sG https://data.cityofnewyork.us/resource/cqsj-cfgu.json \
    --data-urlencode '$select=count(*) as n'
[{"n":"114"}]
```

**The 21 million is 93% bicycles.** This is the first thing to know and the
thing the plan got wrong.

```sql
$ curl -sG .../resource/ct66-47at.json \
    --data-urlencode '$select=travelmode,count(*) as n' \
    --data-urlencode '$group=travelmode' \
    --data-urlencode '$order=n desc'
[{"travelmode":"bike","n":"19738684"},
 {"travelmode":"pedestrian","n":"1505220"},
 {"travelmode":"scooter","n":"25746"}]
```

| Mode | Rows | Share |
| --- | --- | --- |
| `bike` | 19 738 684 | 92.8% |
| `pedestrian` | 1 505 220 | 7.1% |
| `scooter` | 25 746 | 0.1% |

An implementation that sized a 21M-row pipeline around pedestrian counts was
sizing it around bicycles.

## Coverage: four counters, not sixty-seven

`6up2-gnw8` has 67 rows and 42 distinct `id` values, and 43 distinct
`counters_serial` values — more serials than ids, which is the first hint at
[the trap](#the-duplicate-counter-trap).

```sql
$ curl -sG .../resource/6up2-gnw8.json \
    --data-urlencode '$select=count(*) as rows, count(distinct id) as ids, count(distinct counters_serial) as serials'
[{"rows":"67","ids":"42","serials":"43"}]
```

Grouped by declared mode, 42 ids resolve as:

```sql
$ curl -sG .../resource/6up2-gnw8.json \
    --data-urlencode '$select=travelmodes,count(distinct id) as n' \
    --data-urlencode '$group=travelmodes'
[{"travelmodes":"bike","n":"33"},
 {"travelmodes":"bike, pedestrian","n":"4"},
 {"travelmodes":"bike, scooter","n":"1"},
 {"travelmodes":"pedestrian","n":"4"}]
```

No sensor has a null `travelmodes`. So pedestrian coverage is
`4 + 4 = 8` sensor rows, and those 8 rows are **four physical counters
published twice each**.

Exactly 8 distinct `sensor_id` values have any pedestrian row, and all 8 resolve
in the sensors dataset:

```sql
$ curl -sG .../resource/ct66-47at.json \
    --data-urlencode '$select=sensor_id,count(*) as rows,min(timestamp) as first,max(timestamp) as last,sum(counts) as total,min(counts) as minc,max(counts) as maxc' \
    --data-urlencode '$where=travelmode='\''pedestrian'\''' \
    --data-urlencode '$group=sensor_id' '$order=sensor_id'
300028963  rows=214172  2022-09-02T11:15 .. 2025-09-22T01:30  total=1867502  min=0  max=263
300029648  rows=214172  2022-09-02T11:15 .. 2025-09-22T01:30  total=1867502  min=0  max=263
300038506  rows=171368  2023-12-27T10:00 .. 2026-06-07T01:45  total=559325   min=0  max=755
300038509  rows=193042  2023-12-27T12:15 .. 2026-09-28T01:15  total=963979   min=0  max=1453
300040736  rows=174028  2024-04-04T13:45 .. 2026-09-28T01:00  total=351606   min=0  max=316
300043073  rows=174028  2024-04-04T13:45 .. 2026-09-28T01:00  total=351606   min=0  max=316
300043075  rows=193042  2023-12-27T12:15 .. 2026-09-28T01:15  total=963979   min=0  max=1453
300043077  rows=171368  2023-12-27T10:00 .. 2026-06-07T01:45  total=559325   min=0  max=755
```

The per-counter truth, with `in` and `out` summed once:

| Counter | `counters_serial` | `sensor_id` A | `sensor_id` B | Borough | Sum of counts |
| --- | --- | --- | --- | --- | --- |
| Concrete Plant Park | YAH22104563 | 300040736 | 300043073 | Bronx | 351 606 |
| Emmons Ave | YAH22104564 | 300038509 | 300043075 | Brooklyn | 963 979 |
| High Bridge | YAH22104566 | 300038506 | 300043077 | Manhattan | 559 325 |
| Willis Ave | YAH22104565 **and** YAH18055368 | 300028963 | 300029648 | Bronx | 1 867 502 |
| | | | | **Total** | **3 742 412** |

Boroughs are not in the source and must be derived; they were resolved by
point-in-polygon against NYC Open Data `gthc-hcne` (Borough Boundaries).

```sql
$ curl -sG .../resource/gthc-hcne.json \
    --data-urlencode '$select=boroname' \
    --data-urlencode '$where=intersects(the_geom, '\''POINT (-73.93099 40.5841)'\'')'
[{"boroname":"Brooklyn"}]
```

`Emmons Ave` at 40.5841 is **Brooklyn**, not the Bronx; `High Bridge` at 40.8422
is **Manhattan**. Getting this wrong is the sort of thing that survives review
because it looks right.

### Which of the four are actually alive

"Alive" is not the same as "has a row today". One counter is **fresh, reporting,
and returning only zeros**.

| Counter | Newest row | Age at 2026-09-28 | **Newest non-zero reading** | Verdict |
| --- | --- | --- | --- | --- |
| Emmons Ave | 2026-09-28T01:15 | 4 h | 2026-09-27T23:45 | **live** |
| Concrete Plant Park | 2026-09-28T01:00 | 4 h | **2026-08-14T11:30** | **stuck at zero, 45 days** |
| High Bridge | 2026-06-07T01:45 | 113 d | **2026-04-22T10:30** | **dead, last 46 days all zero** |
| Willis Ave | 2025-09-22T01:30 | 371 d | 2025-09-22T01:30 | **dead** |

**One of the four counters is currently producing data.** Concrete Plant Park
reports a row every 15 minutes, `status: raw`, `granularity: PT15M`, with a
timestamp four minutes old, and every one of those readings is `0`. A
freshness check derived from the newest observation — the obvious design, and
the one in `scripts/walk/_common.py` — calls it `fresh`. It is a dead counter.

The MVP as originally specified would have shipped a two-dot map. In fact it
would have shipped a two-dot map in which one dot was wrong, and would have
looked correct.

## The duplicate-counter trap

This is the most dangerous thing in the project, because the failure is silent,
the result is plausible, and the wrong answer is exactly 2×.

Each of the four physical counters is published under two `sensor_id` values:
one row tagged `bike, pedestrian` and one tagged `pedestrian`. The two rows
share a `counters_serial`, share byte-identical lat/lon, and carry a
**byte-identical count series**. This was verified by downloading both
`sensor_id` series for two counters and comparing the `(timestamp, direction) →
counts` maps:

```python
# Concrete Plant Park: 300040736 vs 300043073
# Emmons Ave:        300038509 vs 300043075
keys A=174028  keys B=174028  identical series=True  differing keys=0
keys A=193042  keys B=193042  identical series=True  differing keys=0
```

The `bike, pedestrian` sensor carries **both** modes' rows, so the pedestrian
rows are present under both ids:

```sql
$ curl -sG .../resource/ct66-47at.json \
    --data-urlencode '$select=travelmode,max(timestamp) as last,count(*) as n' \
    --data-urlencode '$where=sensor_id='\''300040736'\''' \
    --data-urlencode '$group=travelmode'
[{"travelmode":"bike","last":"2026-09-28T05:00:00.000","n":"174028"},
 {"travelmode":"pedestrian","last":"2026-09-28T01:00:00.000","n":"174028"}]
```

Its twin, tagged `pedestrian`, has the same 174 028 rows and no bike at all.

### What summing `direction` costs, and what summing `sensor_id` costs

**Summing `direction` in + out is correct.** The two rows are genuinely
separate flows: a pedestrian walks in and walks out, and a directional sensor
splits one sidewalk into two counted directions. The pedestrian split is
exactly even — 752 610 `in` and 752 610 `out` — which is what a screenline
looks like.

```sql
$ curl -sG .../resource/ct66-47at.json \
    --data-urlencode '$select=direction,count(*) as n' \
    --data-urlencode '$where=travelmode='\''pedestrian'\''' \
    --data-urlencode '$group=direction'
[{"direction":"in","n":"752610"},{"direction":"out","n":"752610"}]
```

**Summing `sensor_id` is exactly 2× wrong.** The eight `total` values above sum
to 7 484 824, which is 2 × the true 3 742 412. A plausible-looking map, wrong
by precisely a factor of two, with nothing in the UI to say so.

This is why the published id is keyed on `counters_serial`
(`_common.sensor_id()` = `wsk-` + `sha1(serial)[:12]`) and why
`resolve_counter_identity()` exists. It is the single most important function
in the walk pipeline.

### Serial is not unique either

Willis Ave carries **two** serials — `YAH18055368`, a 2018 unit with
`counters_detachmentdate: 2022-12-01T11:30:00.000`, and `YAH22104565`, its
2021 replacement. Both are attached to the same two `id` values, and the ETL
stitched the replacement's series onto the old ids across the handover. The
28-day all-zero run at 2022-11-03 → 2022-11-30 (see
[anomalies](#anomalies-and-drift-risks)) is that handover.

So grouping on `counters_serial` alone would produce **two** Willis Ave records,
not one, because the two serials are different strings. That is why
`resolve_counter_identity()` runs a **second pass**: after grouping on the
serial, it clusters the groups on the set of `sensor_ids` they carry and on
rounded coordinates, keeps the lexicographically greatest serial as canonical,
and records the others as aliases. See `_merge_serial_aliases()` in
`scripts/walk/_common.py:761`.

The shipped `sensors.geojson` has **four** features for four physical counters,
with Willis Ave appearing once carrying both `300028963` and `300029648`, so the
doubling is not in the published data.

## Timestamp semantics

The source documentation says:

> "Time is captured in EST time zone."

(`/api/views/ct66-47at.json`, dataset `description`.) That sentence is what
`SOURCE_UTC_OFFSET = timedelta(hours=-5)` in `scripts/walk/_common.py` is
built on — but only as a **degraded fallback** for a host with no tz database.
`NYC_TZ` resolves to `ZoneInfo("America/New_York")` whenever the standard library
can provide it, and `parse_source_timestamp()` uses that, so a July timestamp is
`-04:00`. The degraded path is reported via `NYC_TZ_IS_FULL` rather than
silent.

**The data contradicts the documentation, and the data is right.**

### The spring-forward hole

The first Sunday in March 2026 was 2026-03-01. The second was **2026-03-08** —
the date New York clocks jump from 02:00 EST to 03:00 EDT. Across the entire
21 269 650-row dataset, **that date has no rows at all between 02:00:00 and
02:59:59**:

```sql
$ for y in 2012..2026; do
    d=<second Sunday of March>
    curl -sG .../resource/ct66-47at.json \
      --data-urlencode '$select=count(*) as n' \
      --data-urlencode "\$where=timestamp between '$d 02:00:00' and '$d 02:59:59'"
  done
2013-03-10  rows=0      2020-03-08  rows=0
2014-03-09  rows=0      2021-03-14  rows=0
2015-03-08  rows=0      2022-03-13  rows=0
2016-03-13  rows=0      2023-03-12  rows=0
2017-03-12  rows=0      2024-03-10  rows=0
2018-03-11  rows=0      2025-03-09  rows=0
2019-03-10  rows=0      2026-03-08  rows=0
```

The control is decisive. Every *other* Sunday in March has a normal population
of rows in that window, and so does every Sunday in November:

```sql
-- 02:00-02:59 on each Sunday of March 2025
392, 0, 392, 392, 392          <- the 0 is 2025-03-09
-- 02:00-02:59 on each Sunday of November 2025
376, 376, 376, 376, 376
```

Fourteen consecutive years, no exceptions, and the gap is always exactly
02:00–02:59. In **fixed EST** every one of those 96 quarter-hours exists on
every day of the year, and there is no mechanism by which 02:00 could vanish.
In **New York civil time** 02:00–02:59 does not exist on that date. The
timestamps are naive New York wall-clock labels, notwithstanding what the
description says.

Concretely, at Concrete Plant Park the spring-forward days carry **184 rows**
(92 timestamps × 2 directions) where every other day carries 192:

```python
2025-03-08 rows=192   2025-03-09 rows=184   2025-03-10 rows=192
# missing on 2025-03-09: 02:00, 02:15, 02:30, 02:45
```

### What this breaks

`_common.parse_source_timestamp()` attaches a fixed −05:00 and
`_common.to_nyc_wall_clock()` then re-interprets that instant in
`America/New_York`. For a July observation that applies the −05:00 → −04:00
correction **on top of a label that never needed it**:

```python
to_nyc_wall_clock(parse_source_timestamp('2026-07-01T12:00:00.000'))
# -> 2026-07-01 13:00:00-04:00     the correct value is 12:00:00-04:00
```

Every summer observation is displaced by one hour, and every winter one is
correct. Two consequences, both real:

- **Time-of-day baselines shift for half the year.** A 17:00 observation is
  bucketed as 17:00 in January and 17:00 in July, but the two are an hour apart
  in real behaviour.
- **`staleness_for()` is biased.** It compares `now` against `to_utc()` of the
  observation, so a summer reading is scored an hour staler than it is. With
  `FRESH_WITHIN = 6h` that is not a rounding error; it moves readings across
  the fresh/stale boundary once a day for seven months.

The fix is to treat the label as civil time throughout: localise with
`America/New_York` and never apply a second offset. `time_bucket()` should key
on the label as published, which it already does correctly.

### The autumn hour that is lost

If the label is civil time then 01:00–01:45 occurs **twice** on the first
Sunday in November. The dataset has 96 distinct labels that day, not 100, and
no duplicate rows — so the ETL collapsed the repeated hour and one physical
hour of counts is silently absent, once a year, on every sensor:

```sql
$ curl -sG .../resource/ct66-47at.json \
    --data-urlencode '$select=count(*) as n, count(distinct timestamp) as ts' \
    --data-urlencode "\$where=timestamp between '2025-11-02T00:00:00' and '2025-11-02T23:59:59'"
[{"n":"9024","ts":"96"}]
```

Which of the two hours survives is not determinable from the published data.
It is a one-hour, once-a-year, unquantifiable loss and it should be documented
rather than guessed at.

### `status` and `granularity` carry nothing

```sql
$ curl -sG .../resource/ct66-47at.json \
    --data-urlencode '$select=status,count(*) as n' \
    --data-urlencode '$where=travelmode='\''pedestrian'\''' \
    --data-urlencode '$group=status'
[{"status":"raw","n":"1505220"}]
```

All 1 505 220 pedestrian rows are `raw`, and 100% are `PT15M`. The `status`
vocabulary is real — bike rows do use `modified` — it is simply constant for
pedestrians, exactly like `license_status: Issued` in `fpeh-f7ci`. **Freshness
must be derived.** The UI must not present `status` as if it meant "reporting
normally", and it must not be a filter, because a one-value filter is a lie.

### `flowname` is not a join key

`flowname` is null for **600 916 of 1 505 220** pedestrian rows (39.9%), and the
nulls are systematic rather than random. Every null is inside one of the four
`pedestrian`-only sensors, and within those sensors the split falls on a single
date: **DOT backfilled the flow names on 2025-12-01.** `Concrete Plant Park Peds
IN` exists only from that date onward.

```sql
$ curl -sG .../resource/ct66-47at.json \
    --data-urlencode '$select=min(timestamp) as f,max(timestamp) as l,count(*) as n' \
    --data-urlencode "\$where=travelmode='pedestrian' and sensor_id='300043073' and flowname is not null" \
    --data-urlencode '$group=flowname'
[{"f":"2025-12-01T00:00:00.000","l":"2026-09-28T01:00:00.000","n":"28897"},
 {"f":"2025-12-01T00:00:00.000","l":"2026-09-28T01:00:00.000","n":"28897"}]

$ ... same query with "flowname is null"
[{"f":"2024-04-04T13:45:00.000","l":"2025-11-30T23:45:00.000","n":"116234"}]
```

`Willis Ave Peds` (300029648) is 100% null, for the same reason: it stopped
reporting on 2025-09-22, two months before the backfill. The four
`bike, pedestrian` sensors have had a `flowname` throughout.

```sql
$ curl -sG .../resource/ct66-47at.json \
    --data-urlencode '$select=sensor_id,count(*) as n,count(flowname) as named' \
    --data-urlencode "\$where=travelmode='pedestrian'" \
    --data-urlencode '$group=sensor_id' '$order=sensor_id'
300028963  n=214172  named=214172
300029648  n=214172  named=0
300038506  n=171368  named=171368
300038509  n=193042  named=193042
300040736  n=174028  named=174028
300043073  n=174028  named=57794
300043075  n=193042  named=57796
300043077  n=171368  named=36104
```

So `flowname` is not a join key, not a stable label, and not safe to display.
The `name` column in `6up2-gnw8` is the one to publish, and it needs the
"prefer the shortest name" rule that `resolve_counter_identity()` already
applies, because `Concrete Plant Park` and `Concrete Plant Park Peds` are the
same counter.

## The historical dataset and its three column spellings

`cqsj-cfgu` is 114 rows, 8 descriptive columns and **111 count columns**.
Those 111 columns use **three different spellings in the same row**:

| Spelling | Count | Example | Regex that matches |
| --- | --- | --- | --- |
| `month_YY_period` | **97** | `may_07_am`, `june_24_md` | `^(may\|sept\|oct\|june)_?\d{2}_(am\|md\|pm)$` |
| `monthYY_period` | **12** | `oct24_am`, `may25_pm`, `may26_pm` | same (the `_?` is optional) |
| `month_YY_p_m` | **2** | `may_22_p_m`, `may_23_p_m` | **nothing** |

The 2 in the third row are labelled `May22_pM` and `May23_pM` in the source's
own display names — the `PM` got split into a `p` and an `m`. They hold real
data: `may_22_p_m` is non-null for 112 locations, `may_23_p_m` for 112.

**`HISTORY_COLUMN_RE` in `scripts/walk/_common.py` matches all three rows of
that table**, via the period token `p?_?m`, and canonicalises `p_m` onto the same
`pm` period because it is the same measurement. The docstring above the regex
now says 111 columns and three spellings, and the build reports
`consumedCountColumns: 111` with `unhandledCountColumns: 0`.

When this section was written the regex matched only the first two rows, so those
224 populated observations (112 locations × 2 surveys) were silently dropped. It
was a live defect at the time. It is fixed, and `COUNT_COLUMN_SHAPE_RE` is a
deliberately broader shape-detector used as a schema-drift check, so a *fourth*
spelling is now caught by not matching any understood pattern rather than by a
hand-maintained count.

`may_22_pm` does not exist and Socrata says so, which is a cheap way to prove
the third spelling is the real one:

```sql
$ curl -sG .../resource/cqsj-cfgu.json \
    --data-urlencode '$where=may_22_pm is not null'
{"errorCode":"query.soql.no-such-column", ... "No such column: may_22_pm"}

$ curl -sG .../resource/cqsj-cfgu.json \
    --data-urlencode '$where=may_22_p_m is not null'
[{"n":"112","locs":"112"}]
```

A fourth hazard sits next to the naming: **the column types changed and changed
back.** `oct24_*`, `may25_*` and `oct25_*` are `number`; everything before them
and `may26_*` are `text`. A parser that assumes a number will fail on May 2026,
and one that assumes text will fail on May 2025.

```python
# from /api/views/cqsj-cfgu.json
datatype counts: Counter({'text': 103, 'number': 8})
```

## Survey calendar and coverage gaps

111 columns = **37 surveys** × 3 periods. The calendar is not regular:

| Period | Surveys | Note |
| --- | --- | --- |
| May + September | 2007 → 2018 | two a year, 24 surveys |
| **May 2019 only** | 1 | **no `sept_19_*` column exists at all** |
| **October 2020 only** | 1 | **no `may_20_*` column exists at all** |
| May + October | 2021, 2022, 2023 | September gives way to October |
| **June** + October | 2024 | **surveyed in June, not May** |
| May + October | 2025 | |
| May 2026 | 1 | newest |

**2019 is not entirely absent — and this correction matters.** Only the
*September* 2019 survey is missing. May 2019 exists, and is **partial: 50 of
114 locations**, against 113–114 in every other survey from 2007 to 2018.

```sql
$ curl -sG .../resource/cqsj-cfgu.json \
    --data-urlencode '$select=count(*) as n' \
    --data-urlencode '$where=may_19_pm is not null'
[{"n":"50"}]

$ curl -sG .../resource/cqsj-cfgu.json \
    --data-urlencode '$where=sept_19_pm is not null'
{"errorCode":"query.soql.no-such-column", ... "No such column: sept_19_pm"}

$ curl -sG .../resource/cqsj-cfgu.json \
    --data-urlencode '$select=count(*) as n' \
    --data-urlencode '$where=may_20_pm is not null'
{"errorCode":"query.soql.no-such-column", ... "No such column: may_20_pm"}
```

Recent surveys, non-null of 114:

| Survey | Populated | Missing locations |
| --- | --- | --- |
| `june_24_pm` | 112 | 26, 113 |
| `oct24_pm` | 112 | 26, 113 |
| `may25_pm` | 112 | 26, 113 |
| `oct25_pm` | 112 | 26, 113 |
| `may26_pm` | **113** | 26 |

**Every location has been surveyed at least once** — the earliest survey,
`may_07_*`, already has 112 of 114 populated, and the union over all 37 surveys
covers all 114. `loc 26` (Jay Street, Willoughby to Metrotech Walk, Brooklyn,
`iex=Y`) has dropped out of every survey since June 2024. `loc 113` (Triborough
Bridge, Manhattan span) dropped out from June 2024 to October 2025 and returned
in May 2026 at 58.

Overall the dataset is 97.3% complete — 12 312 of 12 654 cells populated.

### Zero is distinguishable from null here

Unlike the automated data, the historical dataset uses `0` as a real reading
and it is rare: **12 zero cells out of 12 312 populated**, concentrated in
three locations.

```python
# every populated cell whose value is exactly 0, from the 114-row fetch
loc 19  oct_22_am
loc 50  oct_21_am, oct_21_pm, oct_21_md
loc 51  oct_21_md
loc 59  oct_21_am, oct_21_pm, oct_21_md
loc 102 sept_10_am, sept_10_pm, may_18_am, may_18_pm
```

Zero is confined to 2010, 2018, 2021 and 2022; **no recent survey contains
one**, so `may26_pm = '0'` and `may25_pm = 0` both return 0 rows.

```sql
$ curl -sG .../resource/cqsj-cfgu.json \
    --data-urlencode '$select=count(*) as n' \
    --data-urlencode "\$where=may26_pm = 0"
[]

$ curl -sG .../resource/cqsj-cfgu.json \
    --data-urlencode '$select=count(*) as n' \
    --data-urlencode "\$where=may25_pm = 0"
[{"n":"0"}]
```

That is convenient rather than reassuring. The October 2021 triple-zero at
`loc 50` and `loc 59` is almost certainly a survey that did not happen, not an
empty sidewalk, so `0` is a value that means either "nobody walked" or "the
count was never taken" and the dataset does not say which. A pipeline must not
treat `0` as absent, and it must not present `0` as a measurement of emptiness
without a floor — for the automated program the zero share is 32–43%, so the
two datasets would read zeros at wildly different frequencies.

## Sample-size arithmetic

The brief's arithmetic is right. The automated data is essentially complete
within its own span, so a rolling window yields almost exactly one observation
per week per (weekday, 15-minute bucket):

| Window | Samples per (weekday, bucket) |
| --- | --- |
| 4 weeks | 4 – 5 |
| **8 weeks** | **8 – 9** |
| 13 weeks | 12 – 14 |
| 26 weeks | 25 – 27 |
| 52 weeks | 51 – 53 |

**8 observations per bucket is not enough for a 90th percentile, and no longer
window fixes it.** Two separate reasons, and the second is the one that
matters.

**First, the arithmetic.** The highest rank any observation can attain against
`n` samples is `100 − 50/n`, because the tie adjustment places the maximum at
the midpoint of the top tie block:

| n | top attainable rank | `veryBusy` (≥ 90) |
| --- | --- | --- |
| 2 | 75.00 | unreachable |
| 3 | 83.33 | unreachable |
| **4** | **87.50** | **unreachable** |
| 5 | 90.00 | reachable |
| 8 | 93.75 | reachable |

`MIN_SAMPLES = 4` in `_common.py` makes the `veryBusy` label **structurally
impossible**. Not rare — impossible. The moment the baseline reaches four
samples, the top of the distribution cannot cross 90. That is a one-line bug
with a visible consequence: a label that never appears.

At n = 8, `pctl(sorted, 0.90)` interpolates at position `0.90 × 7 = 6.3`,
which is **between the 7th and 8th order statistics of 8** — that is, the two
largest samples, with 70% of the weight on the maximum. The "90th percentile of
the last eight Tuesdays" is, for practical purposes, "the largest of the last
eight Tuesdays".

**Second, and decisively: more samples do not help.** Measuring each
observation's baseline against the *following* `w` weeks' percentile (a
disjoint ground truth), restricted to buckets where the number means something
(06:00–23:00 and baseline median ≥ 5 pedestrians per 15 min):

| Counter | w = 4 | w = 8 | w = 13 | w = 26 |
| --- | --- | --- | --- | --- |
| | p50 / p90 error | p50 / p90 error | p50 / p90 error | p50 / p90 error |
| Concrete Plant Park | 3.0 / 4.2 | 3.0 / 4.6 | 3.0 / 4.6 | 3.0 / 4.0 |
| Emmons Ave | 3.0 / 6.0 | 2.5 / 6.7 | 3.0 / 5.6 | 2.5 / 5.7 |
| High Bridge | 3.5 / 4.7 | 3.5 / 5.4 | 4.0 / 5.8 | 4.5 / 6.0 |
| Willis Ave | 5.0 / 6.4 | 4.5 / 6.2 | 5.0 / 6.6 | 5.0 / 6.0 |

*Median absolute error, in people per 15 minutes.*

The error is **flat across a six-fold change in sample size**. Four weeks and
twenty-six weeks are indistinguishable. The binding constraint is not
sample count — it is the intrinsic week-to-week variance of a sidewalk. A
quarter-year of history does not buy a more truthful baseline; it buys a
baseline that has not noticed autumn yet.

**Recommendation: `MIN_SAMPLES = 8`, with a rolling window of 8 weeks.**

- **8, not 4.** At 4 the `veryBusy` label cannot fire at all. At 8, `pctl(…,
  0.90)` interpolates between two observations rather than returning the single
  maximum, and 8 is the smallest window in which a weekday-and-bucket baseline
  is a month of history that has survived one anomalous occurrence.
- **8 weeks, not longer.** The error table shows no benefit past 4 weeks, and a
  rolling window is the only thing that *recovers* from a bad patch — see
  [the Emmons poisoning case](#a-single-bad-day-poisons-seven-weeks). An
  all-time baseline never forgets a fault.
- **8 weeks, not 4.** A 4-week window lets one bad Friday move half the
  baseline. Two months of the same weekday is the smallest unit that survives
  a single occurrence of anything.

## Distributions and outliers

Folded in+out, per counter, over the whole span:

| Counter | Min | Median | p99 | Max | Zero share |
| --- | --- | --- | --- | --- | --- |
| Concrete Plant Park | 0 | 2 | 24 | **505** | 32.1% |
| Emmons Ave | 0 | 1 | **121** † | **1 454** † | 43.2% |
| High Bridge | 0 | 3 | 33 | **1 098** † | 36.6% |
| Willis Ave | 0 | 16 | 52 | 290 | 3.9% |

† The Emmons and High Bridge figures are inflated by the counter faults in
[anomalies](#anomalies-and-drift-risks), not by pedestrians. High Bridge's
newest non-zero reading is 2026-04-22 and its last 46 days are all zero, so
both the p99 and the max sit in the fault tail.

The medians are the headline: **2, 1, 3 and 16 people per 15 minutes.** A
typical quarter-hour at three of the four counters is between one and three
people. Any UI that renders a raw count next to a label is rendering a number
most users cannot interpret.

The zero share is the first surprise, and it is why the zero/no-zero analysis
below matters: **32–43% of all pedestrian observations at three of the four
counters are exactly zero.** These are night hours on park edges, where a
genuine zero is the correct answer.

The spread between counters is the second, and it is large. Willis Ave's
15-minute maximum is 290; Concrete Plant Park's is 505; Emmons reaches 1 454.
**There is no comparable quantity across these four locations**, because they
count different physical things at different scales. A shared colour scale
keyed to raw counts would paint Emmons permanently saturated and Willis
permanently pale, and both would be right about their own street.

The seasonal swing is large and it is not symmetric:

| Counter | Jan/July | Dec/Aug | peak/trough over the year |
| --- | --- | --- | --- |
| Concrete Plant Park | 0.26× | 0.36× | 4.4× |
| High Bridge | 0.53× | 0.43× | 2.5× |
| Willis Ave | 0.62× | 0.63× | 2.1× |
| Emmons Ave | 0.46× | 0.19× | *see anomalies* |

**September runs 1.5× to 2.7× January at the same weekday and the same
time-of-day.** Measured per (weekday, 15-min bucket), median of
`sept / jan`:

| Counter | sept ÷ jan |
| --- | --- |
| Concrete Plant Park | 2.00× |
| Emmons Ave | 1.50× |
| High Bridge | 2.67× |
| Willis Ave | 1.53× |

This is the strongest argument in the document for a **rolling recent window
over an all-time baseline.** A January observation compared against a
year-round baseline reads 1.5–2.7× too low, and an all-time baseline cannot
recover from a bad patch at all — a fault from 2026 poisons the map until the
next decade. The rolling window is not a simplification here; it is the only
version of this computation that is honest.

## Thresholds: what the data supports

The proposed cut points — 0–25 quiet, 25–75 typical, 75–90 busy, 90–100 very
busy — were a hypothesis. They survive, with three amendments and one
prohibition. Here is the evidence.

### A self-referential percentile is not automatically degenerate

The worry with a percentile-of-own-history scheme is that it is circular: every
sensor is by construction near its own median, so every sensor reads "typical"
and the map is uniformly green. Measured, the outcome depends entirely on
whether the baseline window **contains** the observation.

Baseline containing the observation (the naive implementation) reproduces the
input distribution, as it must:

| Counter | quiet | typical | busy | veryBusy |
| --- | --- | --- | --- | --- |
| Concrete Plant Park | 32.1% | 41.8% | 15.7% | 10.4% |
| Emmons Ave | 43.2% | 33.8% | 13.3% | 9.8% |
| High Bridge | 36.6% | 37.3% | 15.6% | 10.5% |
| Willis Ave | 24.7% | 49.1% | 15.9% | 10.3% |

Baseline a **trailing 8-week window that excludes the observation** — the honest
version — converges on the proposed split, and does so independently at both
live counters:

| | quiet | typical | busy | veryBusy |
| --- | --- | --- | --- | --- |
| Concrete Plant Park | 21.4% | 51.8% | 15.1% | 11.7% |
| Emmons Ave | 16.7% | 57.5% | 14.6% | 11.1% |
| **Both live counters** | **18.9%** | **54.8%** | **14.9%** | **11.4%** |

The scheme separates. The proposed 25/50/15/10 is not the distribution you get;
you get 19/55/15/11. That is close enough to endorse the **cut points** while
being precise that the shares are an output, not a target. Do not validate the
pipeline by asserting a 25% quiet share; assert nothing about the shares.

### The real degeneracy: a zero in a zero-inflated hour

The circularity worry was the wrong one. The actual failure is sharper.

30–36% of the day at three of the four counters sits in a
(weekday, bucket) whose **median is zero**. In those buckets the baseline is
mostly zeros, so a genuine zero — an empty park path at 1am — ranks at the
28th–36th percentile, inside the `typical` band:

```python
# Concrete Plant Park, 01:00 buckets, median = 0
01:00  n=130  median=0.0  percentile of a 0 = 32.7 -> typical
01:00  n=130  median=0.0  percentile of a 0 = 30.8 -> typical
01:00  n=130  median=0.0  percentile of a 0 = 28.1 -> typical
```

**An empty street at 1am reads "typical".** `quiet` never appears at night. A
user opening the map at 3am sees a field of confident green dots on streets
where nobody is walking. The label is not wrong — 1am *is* typical for 1am —
but it is useless, and "typical" is the one label that is not actionable.

| Counter | Share of observations in a bucket whose median is 0 |
| --- | --- |
| Concrete Plant Park | 30.2% |
| Emmons Ave | 36.4% |
| High Bridge | 32.1% |
| Willis Ave | 0.0% |

### Alternatives, evaluated

**Ratio to the sensor's own 8-week median for the same bucket.** Immune to
outliers, and it behaves correctly where the percentile scheme degenerates:

```python
# Emmons Ave, Friday 18:00, trailing 8-week MEDIAN baseline
2026-03-20  count=1     median=1   ratio=1.0x
2026-05-15  count=1118  median=0   no baseline (all-zero bucket)
2026-05-22  count=2     median=0   no baseline
2026-06-19  count=10    median=2   ratio=6.7x
2026-07-24  count=7     median=3   ratio=2.3x
```

The latched day of 1 118 moves the median baseline from 0 to 1. It never
approaches 1 118. And where the median is zero the scheme reports *no
baseline* rather than dividing by zero. This is the correct degenerate
behaviour, and it is the behaviour the percentile scheme gets wrong.

**Normalising by a citywide-relative factor.** Rejected on arithmetic. There
are **two** live counters. A citywide median is the median of two numbers, and
the two are 2.7× apart in the same bucket. The historical program has 114
locations, but it measures a different thing on a different day with a
different unit — an AM/MD/PM screenline total is not a 15-minute bidirectional
count, and nothing in either dataset converts one to the other. There is no
shared scale, so there is no citywide factor to compute.

**Ranking the four counters against each other.** Rejected, and it is worth
saying why out loud, because it is the thing this feature is most likely to be
driven towards. The nearest pair of counters is 3 993 m apart and the furthest
is 28 648 m. The nearest automated sensor to any historical screenline is
624 m, and **the two programs share no co-located pair at all.** There is no
basis for saying Emmons Avenue is busier than Concrete Plant Park, or that
either is busier than High Bridge. They are four different places, and the data
says nothing about the kilometres between them.

### Recommendation

**Keep the four labels and the four cut points. Change three things.**

1. **`MIN_SAMPLES` 4 → 8.** At 4, `veryBusy` is unreachable — see
   [sample-size arithmetic](#sample-size-arithmetic). 8 is also the smallest
   window in which a weekday-and-bucket baseline survives one anomalous
   occurrence.
2. **The baseline is the trailing 8-week median for the same weekday and
   15-minute bucket, and the label is a ratio band on it — not a percentile.**
   The ratio is what makes a zero-inflated night bucket resolve to `quiet`
   instead of `typical`, and what makes a latched day harmless. Concretely:
   where the baseline median is above zero, `quiet` below 0.5×, `typical`
   0.5–1.5×, `busy` 1.5–2.5×, `veryBusy` at or above 2.5×. The 0.5/1.5/2.5 cut
   points are the nearest round numbers to the quartiles of the measured ratio
   distribution below.

   **Where the baseline median is zero there is no scale, and the label must
   branch rather than divide.** A current reading of `0` is `quiet` — zero is
   the floor of the count and there is nothing above it. A current reading
   above zero is `unavailable`, because with no positive reference we cannot
   say whether 5 people on a path whose median is 0 is a busy hour or a rare
   one. The share of observations in this state, and how they split:

   | Counter | Median-0 buckets, n | current = 0 → `quiet` | current > 0 → `unavailable` |
   | --- | --- | --- | --- |
   | Concrete Plant Park | 20 110 | 14 843 | 5 267 (26.2%) |
   | Emmons Ave | 36 677 | 26 802 | 9 875 (26.9%) |
   | High Bridge | 27 165 | 22 535 | 4 630 (17.0%) |
   | Willis Ave | 793 | 132 | 661 (83.4%) |

   The honest consequence is that the map is largely `quiet` or `unavailable`
   between midnight and 06:00. That is the truth: those are the hours this data
   can say almost nothing about, and a confident "typical" would be a worse
   answer than an honest blank.
3. **A fault gate runs before the label is computed, and it overrides the
   staleness the age buckets would have published.** See
   [anomalies](#anomalies-and-drift-risks) and
   [ADR 0007](adr/0007-fault-a-counter-publishing-zeroes-is-not-fresh.md). A
   counter that fails it is published `staleness: "faulted"` and
   `active: false` even when its newest observation is an hour old, which is what
   the age buckets alone would have called `fresh`.

   It does **not** suppress the numbers. `count`, `expected`, `percentile` and
   `ratio` are still published, as they are for an `offline` counter, because
   deleting them would hide the evidence that produced the fault — the whole
   argument is a run of real measurements that happen to be zero. What is
   withheld is the *belief* in them: the staleness says the counter is broken and
   the detail headline says so in words, so the number below is read as a broken
   instrument rather than an empty street.

Measured ratio distribution for the two live counters, 8-week median baseline,
over the observations where the baseline median is above zero:

| | < 0.5× | 0.5–1.5× | 1.5–2.5× | ≥ 2.5× |
| --- | --- | --- | --- | --- |
| Concrete Plant Park | 30.6% | 40.0% | 17.2% | 12.2% |
| Emmons Ave | 34.9% | 34.0% | 15.7% | 15.5% |

The first row is the reason the recommended cut points are not the percentile
cut points. Under the ratio scheme the quartiles land at roughly 0.5×, 1.0× and
2.5×, and a 1.0× cut is a median, not a 75th percentile.

## Missing data and the missing-is-not-zero rule

**Absence is missing, and it is implementable.** Socrata omits absent
observations entirely, so a gap in the 15-minute grid is a missing observation
and a present row is a measurement. There is no `null` row to confuse with
anything. The rule is straightforward and the pipeline already encodes it:
`parse_count()` returns `None` for absent and never for zero.

Within each counter's own span the grid is essentially complete:

| Counter | Grid slots in span | Present | Coverage | Null `counts` | Zeros |
| --- | --- | --- | --- | --- | --- |
| Concrete Plant Park | 87 022 | 87 014 | 99.99% | 0 | 27 912 |
| Emmons Ave | 96 533 | 96 521 | 99.99% | 2 | 41 659 |
| High Bridge | 85 696 | 85 684 | 99.99% | 0 | 31 336 |
| Willis Ave | 107 098 | 107 086 | 99.99% | 0 | 4 203 |

The only 4 missing slots per full year are the 02:00–02:45 DST hole, and the
only 2 null `counts` values in the entire pedestrian dataset are both at Emmons
Ave on 2025-05-28 (13:30 and 13:45) — one instance, 4 rows.

**But the rule is necessary and not sufficient.** A present `0` is a
measurement, and the source does sometimes publish a measurement that is a
fault. See below.

## Anomalies and drift risks

Everything in this section is present in the data today, with `status: raw` and
`granularity: PT15M` on every affected row.

### A single bad day poisons seven weeks

Emmons Ave's `in` channel latched. From 2026-05-12 to 2026-05-20 it reported
physically impossible values while the `out` channel stayed normal:

| timestamp | in | out |
| --- | --- | --- |
| 2026-04-10T18:00 | 0 | 0 |
| 2026-05-12T18:00 | 0 | 0 |
| 2026-05-16T18:00 | **1 146** | 35 |
| 2026-05-20T02:30 | **1 387** | 2 |

1 387 pedestrians on Emmons Avenue at half past two in the morning. The daily
totals over the episode:

```
2026-05-11  0        2026-05-15  87965      2026-05-19  83248
2026-05-12  44       2026-05-16 103494  <-  2026-05-20  41344
2026-05-13 20457     2026-05-17  91132      2026-05-21   156
2026-05-14 55944     2026-05-18  69172      2026-05-22   241
```

A daily median of 264 and a maximum of 103 494 — **392× the median**, on a
residential street.

Now run the proposed scheme over Friday 18:00 at Emmons Ave, with a trailing
8-week baseline:

| Date | Count | Trailing 8w p90 | Percentile | Label |
| --- | --- | --- | --- | --- |
| 2026-04-17 | 0 | 3 | 31.2 | typical |
| 2026-05-08 | 0 | 2 | 37.5 | typical |
| **2026-05-15** | **1 118** | 0 | 100.0 | **veryBusy** |
| 2026-05-22 | 2 | **335** | 87.5 | **busy** |
| 2026-05-29 | 10 | **337** | 87.5 | **busy** |
| 2026-06-05 | 3 | 342 | 75.0 | **busy** |
| 2026-06-12 | 1 | 342 | 50.0 | typical |
| 2026-06-19 | 10 | 342 | 81.2 | **busy** |
| 2026-06-26 | 1 | 342 | 31.2 | typical |

One bad Friday produces the most confident wrong answer the scheme can emit —
`veryBusy` on a fault — and then **two months of "busy" on a near-empty
street**, because the 1 118 is now inside the 8-week window and `pctl(…, 0.90)`
hands the maximum 70% of the weight. The baseline is 335 when the true value is
0–3.

The same series under a trailing 8-week **median** baseline:

| Date | Count | Trailing 8w median |
| --- | --- | --- |
| 2026-05-15 | 1 118 | 0 |
| 2026-05-22 | 2 | 0 |
| 2026-06-19 | 10 | 2 |
| 2026-06-26 | 1 | 2 |

The fault never enters the baseline. This is the single clearest argument for
the ratio-over-median recommendation, and it is the argument that stops the
scheme from being a machine for converting counter faults into map features.

### Long all-zero runs are faults, not quiet streets

| Counter | All-zero days | Runs ≥ 3 days | Longest run |
| --- | --- | --- | --- |
| Concrete Plant Park | 51 | 2 | **2026-08-15 → 2026-09-28, 45 days, ongoing** |
| Emmons Ave | 90 | 7 | 2025-04-10 → 2025-05-02, 23 days |
| High Bridge | 114 | 6 | **2026-04-23 → 2026-06-07, 46 days** |
| Willis Ave | 28 | 1 | 2022-11-03 → 2022-11-30, 28 days |

These are days on which a row is **present** for every 15 minutes and every
reading is `0`. Concrete Plant Park is presently inside a 45-day run. A park
path on which nobody walks for 45 consecutive days is not a measurement.

Note the consequence for freshness: Concrete Plant Park's newest row is four
minutes old, so `staleness_for()` returns `fresh`. The all-zero-run detector is
the only thing that catches this counter, and it is not optional.

Willis Ave's 28-day November 2022 run is the one legitimate case — it is the
physical gap between the 2018 unit and its 2021 replacement.

### The `direction` split is the fault detector

| Counter | Median \|in−out\|/(in+out) | Rows > 0.5 |
| --- | --- | --- |
| Concrete Plant Park | 0.429 | 42.8% |
| Emmons Ave | 0.500 | 47.7% |
| High Bridge | 0.308 | 27.8% |
| Willis Ave | 0.304 | 24.8% |

The distribution is bimodal by construction — a single screenline with one
direction dominant puts many timestamps near 1.0 — so the raw statistic needs a
window, not a single row. Applied as a **trailing multi-day ratio** it is
unambiguous: Emmons Ave at 1387/2 is not a direction split, it is one channel
latched. `status` does not carry this signal and nothing else in the dataset
does.

### `lastdata` in the sensor metadata is not pedestrian freshness

For 8 of the 10 pedestrian sensor rows `lastdata` matches the counts. For both
Willis Ave rows it is **100 days stale**:

| `sensor_id` | `lastdata` in `6up2-gnw8` | Actual newest row | |
| --- | --- | --- | --- |
| 300028963, 300029648 (both Willis Ave rows) | 2025-12-31 | 2025-09-22 | **MISMATCH, 100 days** |
| the other 8 pedestrian sensor rows | — | — | match |

`resolve_counter_identity()` stores `firstData`/`lastData` from the metadata
into the group, and `SENSOR_PROPERTY_ORDER` publishes
`firstObservation`/`lastObservation`. If those published fields are filled from
the sensor metadata rather than from the counts, Willis Ave ships as "live
until 2025-12-31" — a counter dead for a year. **Derive them from the counts
and nothing else.** `staleness_for()` already does the right thing; the
question is only whether the two fields it is presented with agree with it.

### One sensor id in the metadata has no data at all

`6up2-gnw8` has 42 distinct ids; 41 have rows in `ct66-47at`. `100048744` has
metadata and nothing else. It is not pedestrian-capable and costs nothing, but
the count is 41, not 42, and a coverage assertion written against 42 will fail
for a reason that has nothing to do with the pipeline.

### No duplicates

Checked on all four counters: **zero** duplicate `(timestamp, direction)` keys.
The earlier suspicion that `flowid` repeats is a misreading — **`flowid` is a
flow identifier, not a row identifier.** There are exactly 16 of them across
1 505 220 pedestrian rows, which is 8 sensors × 2 directions:

```sql
$ curl -sG .../resource/ct66-47at.json \
    --data-urlencode '$select=flowid,sensor_id,direction,count(*) as n' \
    --data-urlencode "\$where=travelmode='pedestrian' and timestamp > '2026-09-01T00:00:00'" \
    --data-urlencode '$group=flowid,sensor_id,direction'
[{"flowid":"353418025","sensor_id":"300038509","direction":"in","n":"2597"},
 {"flowid":"353418026","sensor_id":"300038509","direction":"out","n":"2597"},
 {"flowid":"353438190","sensor_id":"300040736","direction":"in","n":"2596"},
 {"flowid":"353456318","sensor_id":"300043073","direction":"in","n":"2596"},
 {"flowid":"353456320","sensor_id":"300043073","direction":"out","n":"2596"},
 {"flowid":"353456325","sensor_id":"300043075","direction":"in","n":"2597"},
 {"flowid":"353456326","sensor_id":"300043075","direction":"out","n":"2597"},
 ...]
```

Two rows sharing a `flowid` are two timestamps on the same series. The correct
deduplication key is `(sensor_id, timestamp, direction)`, and against that key
the pedestrian dataset is clean. Percentiles will not be corrupted by
duplicates.

## What this data cannot support

This is the section that should be read before anything is built.

**It cannot say where to walk.** The automated program has ever measured 4
locations and currently produces data at 1 of them. A map of where to walk needs
a network; this is four points, one of them stale. The `Never` list in
[`contributing.md`](contributing.md#what-not-to-add) already forbids
recommendations and rankings, and the coverage finding is a second, independent
reason: the data is not there.

**It cannot interpolate to unmeasured streets.** The nearest automated sensor to
any historical screenline is 624 m away, and the two programs share no
co-located pair at all. Inside the automated program the closest pair of
counters is 3 993 m (High Bridge to Willis Ave) and the furthest is 28 648 m.
Between any two counters there is nothing but the basemap. A heat surface, an
isochrone, a "walkability" fill, a shade between two dots — each of these is a
picture of the interpolation, not of the data.

**It cannot compare boroughs.** The automated program has one sensor in the
Bronx (which is stuck at zero), one in Brooklyn, one in Manhattan, and none in
Queens or Staten Island.

The historical program's `borough` column is not a borough column either. It has
**seven** values, three of which are place types rather than boroughs:

```python
Counter({'Manhattan': 36, 'Brooklyn': 26, 'Queens': 25,
         'Harlem River Bridges': 9, 'Bronx': 8, 'Staten Isla': 5,
         'East River Bridges': 5})
```

`Staten Isla` is a **truncated string** — the last two characters are missing
from the source — so a filter on the five NYC borough names from
`contributing.md` silently drops 5 Staten Island locations and 14 bridges.
Those 14 bridge rows are `loc 101`–`loc 114`, the East River bridges
(Brooklyn, Manhattan, Williamsburg, Queensboro) and the Harlem River bridges
(Broadway, University Heights, Macombs Dam, 145th Street, Madison Avenue, Third
Avenue, Willis Avenue, Triborough, and `Wards Isla Bridge` — another source
typo, for Wards Island). Plus one Hudson River Greenway location, `loc 70`,
50th to 51st Street.

So the answer to "how many bridges" is 14, not 13, and the answer to "is this
a borough filter" is that the column cannot support one without a documented
remapping. Comparing boroughs from 8 automated counters and 26 Brooklyn
historical screenlines is not a comparison.

**It cannot compare the four counters to each other.** The per-15-minute median
differs 8× across the four — 16 at Willis Ave, 3 at High Bridge, 2 at Concrete
Plant Park, 1 at Emmons Ave — because they count different physical things at
different scales. There is no shared unit, and building one would be inventing
it. The 15-minute maxima are no better: 290, 1 098, 505, 1 454, and two of those
four are counter faults rather than pedestrians.

**It cannot tell you what a street feels like.** A screenline count is a
magnitude. It has no direction of travel in the pedestrian program beyond
`in`/`out` split by the sensor's own geometry, no speed, no dwell, no
accessibility information, no lighting, no crossing, no seating. A "quiet"
street and an "empty" street are the same measurement and are not the same
place.

**It cannot tell you anything about a time of day you have no baseline for.**
30–36% of the day at three of four counters has a zero-median baseline. Those
buckets need a rule, not a percentile.

**It cannot survive a counter fault without one.** The scheme is a ratio against
8 recent observations. A counter that latches, or a counter that reports zero
for a month, will produce confident and wrong labels unless a fault gate runs
first. `status` will not catch it. `granularity` will not catch it. The
`direction` split and the all-zero-run detector will.

As shipped, the all-zero-run half runs and is
[ADR 0007](adr/0007-fault-a-counter-publishing-zeroes-is-not-fresh.md); the
`direction` split does not, and cannot until there is a case of a lopsided split
in a snapshot to tune it against. So a counter that *latches* — reports, on
schedule, a plausible one-directional split — is still a live failure mode, and
this paragraph is not yet fully answered.

**The historical program cannot be used as a baseline for the automated one.**
Different method, different unit, different day, no co-located pairs. A
"typical" from `cqsj-cfgu` and a "typical" from `ct66-47at` are two different
words. They belong in two files, are classified by two sets of rules, and are
never summed or joined numerically. That separation is already stated in
`scripts/walk/_common.py` and it should survive into the ADR.

## Open questions for the maintainer

> **How to read this section.** Questions 1 to 6 were open when this document
> was written on 2026-09-28 and were settled by the code before the branch
> merged. Each of them is recorded below with the file and line that answers it,
> so the next reader checks the implementation instead of inheriting a question
> that is already closed. That inversion happened repeatedly while the pipeline
> was being built — the "open" text outlived the code by days — so **if an item
> here disagrees with the code, the code is right and this section is stale.**
> Question 7 is the only one still open.

### Resolved

1. **Willis Ave has two `counters_serial` values and one location.**
   **Resolved: two-pass collapse, and the data confirms it.** The question
   assumed `resolve_counter_identity()` keys on `counters_serial` alone and asked
   whether the key should become `(rounded lat, lon)` with the serial as
   metadata. It did not have to: the function runs a *second* pass after the
   serial grouping, clustering on the set of `sensor_ids` and on rounded
   coordinates, keeping the lexicographically greatest serial as canonical and
   recording the others as aliases. See `resolve_counter_identity()` and
   `_merge_serial_aliases()` in `scripts/walk/_common.py:663` and `:761`.

   The published artifact settles it: `sensors.geojson` carries **four** features
   for four physical counters, and Willis Ave appears once carrying both
   `300028963` and `300029648`. The doubling the question predicted is not in
   the data.

2. **What publishes the third column spelling?**
   **Resolved: the regex, and the count is asserted.** `HISTORY_COLUMN_RE` is
   `^(may|sept|oct|june)_?(\d{2})_(am|md|p?_?m)$` (`scripts/walk/_common.py:994`)
   and canonicalises `p_m` to the same `pm` period, because it is the same
   measurement — DOT's own column label reads "May22_pM". The build reports
   `consumedCountColumns: 111` and `unhandledCountColumns: 0`, and the
   106-columns-and-two-spellings docstring is corrected in place.

   The suggestion to assert the count so a *fourth* spelling is caught rather
   than dropped was also taken, but by a different mechanism than "37 surveys ×
   3": `COUNT_COLUMN_SHAPE_RE` is a deliberately broader shape-detector used as
   a schema-drift check, so a new spelling is caught by not matching any
   understood pattern. A parser that grew to accept every spelling that has ever
   occurred would not be evidence that the next one is handled; that regex is.
   See `scripts/walk/history/transform.py:207`.

3. **Is the "Time is captured in EST time zone" description wrong?**
   **Resolved: the description is wrong; the data is New York civil time.**
   `parse_source_timestamp()` resolves in `America/New_York` via a ZoneInfo, not
   at a fixed `-05:00`, so a July timestamp is `-04:00`
   (`scripts/walk/_common.py:488`). The fourteen-year missing 02:00 hour is the
   evidence, and the code says so.

   The separate ADR the question asked for is not needed. Inverting the
   interpretation is not a live choice: the source publishes civil time, so
   reading it as a fixed EST offset would be the error. ADR 0006 records the
   reading-timestamps-as-civil-time decision among its consequences.

4. **Which of the two 01:00 hours survives on the first Sunday in November?**
   **Resolved by choosing, and documenting, the first.** The ambiguity is real
   and the source offers no disambiguating column, so it cannot be recovered —
   the question's own conclusion was right about that. The decision is to take
   `fold=0` (the first occurrence, still on daylight time) and make it
   deterministic rather than incidental: `FALLBACK_ASSUMED_FOLD = 0`
   (`scripts/walk/_common.py:477`). The alternative — refusing to parse real data
   — is worse, and the constant is named for the assumption it encodes so the
   loss is visible rather than silently absorbed.

5. **Should a counter that reports zeros for 45 days publish a label at all?**
   **Resolved: yes, and a distinct one.** A new `faulted` staleness state,
   recorded in
   [ADR 0007](adr/0007-fault-a-counter-publishing-zeroes-is-not-fresh.md). The
   other two options in the question were both rejected with reasons: reusing
   `unavailable` would put a claim about the counter on an axis that describes
   the street, and dropping the counter from `sensors.geojson` hides the fact
   that it exists and is broken.

   The motivation was stronger than the question recorded. Because `active` is
   derived from `staleness`, the pre-gate behaviour published
   `staleness: "fresh"`, `active: true`, `activity: "quiet"`, `count: 0` — a dead
   counter drawn as a live, empty park. Every field true, the sentence they
   formed a lie.

6. **What is the fault gate's threshold, and what is its false-positive rate?**
   **Resolved for the all-zero-run detector, on a measured separation.** Over the
   57-day window, Concrete Plant Park's longest run of days with no nonzero
   reading anywhere in them is **45**; Emmons Ave's — the one working counter —
   is **1**. `FAULT_ZERO_DAYS = 7` sits an order of magnitude from both, and is
   set on the healthy counter's noise floor rather than the failed one, because a
   false positive costs a *working* counter its label while a miss degrades to
   the `quiet` label that shipped before. Both ends are pinned by tests, and so
   is the "never faulted" direction over a 50-day busy window.

   The `|in−out|/(in+out)` half is **still not implemented, deliberately.** There
   is no case of a lopsided split in the committed snapshot, so any constant
   would be chosen without a measured false-positive rate — an untuned constant
   that looks tuned, which is the same error as `MIN_SAMPLES` at 4. ADR 0007
   records the reasoning so it is not re-proposed as a small addition.

### Open

7. **Is there a fifth program?** DOT publishes more pedestrian data than these
   three datasets. Whether any of it has broader coverage is worth one hour of
   searching before the direction is fixed for good — the historical program
   proves DOT can count 114 locations when it chooses to, so "four counters" is
   a fact about these two datasets and not necessarily about the city. Nothing
   in the shipped pipeline depends on the answer, and answering it would not
   change any published field, so it is worth doing on its own merits rather than
   as a blocker.
