# 0006. Lead with the bi-annual counts, not the live feed

**Status:** Accepted
**Date:** 2026-09-28

This is the ADR for a second NYC Open Data layer, which is a trigger in
[`decisions.md`](../decisions.md#when-you-need-a-new-adr). It is additive to the
ones already in force and supersedes none of them:

- [ADR 0001](0001-freeze-the-location-schema.md) governs `src/types/walk.ts` and
  `scripts/walk/` exactly as it governs `src/types/location.ts` and `scripts/`.
  Two implementations of one contract, changed together.
- [ADR 0002](0002-hash-features-never-the-timestamp.md) governs the commit gate,
  and this decision takes its "each layer gets its own hash" clause literally:
  the two walk halves have separate hashes and are compared separately.
- [ADR 0003](0003-keyless-basemap-three-runtime-deps.md) is untouched. Same
  basemap, same three runtime dependencies, same standard-library pipeline, no
  key, no account, nothing new to fork.

The reasoning it rests on is measured, not estimated, and every query is in
[`walk-data-analysis.md`](../walk-data-analysis.md). The reader-facing version is
[`where-nyc-walks.md`](../where-nyc-walks.md).

## Context

The plan for "Where NYC Walks" was an MVP led by NYC DOT's **automated
pedestrian counters**, with DOT's **bi-annual screenline counts** deferred as
"later, secondary". Phase 1 measured both programs against the live endpoints.
The plan was backwards, and shipping it as written would have shipped a
two-dot map in which one dot was wrong.

**1. The automated program is four physical counters, published twice each.**
`6up2-gnw8` has 67 rows, 42 distinct `id` values and 43 `counters_serial`
values. Grouped by declared mode, those 42 ids resolve as `bike` 33,
`bike, pedestrian` 4, `pedestrian` 4, `bike, scooter` 1 — so pedestrian
coverage is **8 sensor rows**, and those 8 rows are **4 physical counters
published twice**. And the 21 269 650 rows in `ct66-47at` are 92.8% bicycle;
pedestrian is 1 505 220 rows, 7.1%. An implementation that sized a 21M-row
pipeline around pedestrian counts was sizing it around bicycles.

**2. Summing the twins doubles the city's entire measured pedestrian volume,
silently.** Each counter is published under two `sensor_id` values — one tagged
`bike, pedestrian`, one tagged `pedestrian` — with the same `counters_serial`,
byte-identical coordinates and a byte-identical count series. Summed by
`sensor_id`, the eight totals come to **7 484 824**; the physical figure is
**3 742 412**. The failure is not loud: it is a map that is wrong by precisely
2× and looks entirely plausible. Willis Ave is worse — it publishes one series
under **two** serials (a 2018 unit and its 2021 replacement), so a single-pass
grouping on serial returns the same location twice and doubles it again.

Summing `direction` in + out is *correct* and stays. Those are two counted
directions of one sidewalk, and the split is exactly even — 752 610 `in`,
752 610 `out` — which is what a screenline looks like. The twins are two
publications of one measurement; `in` and `out` are two measurements.

**3. The feed is a daily batch, not a 15-minute stream.** At 2026-09-28T19:53Z,
`ct66-47at`'s `rowsUpdatedAt` was 12:21Z — **7.6 hours old** — and the newest
pedestrian row was 01:15 civil time, **14.6 hours old**. The pattern is
unambiguous: 55 of the 57 days in the snapshot carry exactly 768 pedestrian
rows (2 counters × 2 sensor ids × 2 directions × 96 quarter-hours) and the
current day is truncated at 01:15. The dataset description implies a live
stream; it is an overnight batch with a multi-hour ingestion lag.

The counters are also dying. Of the four, **two are `stale` and two are
`offline`** in the published snapshot — last readings 2026-06-07 (113 days) and
2025-09-22 (371 days) — and `active` is false for all four. The one counter
still reporting rows every 15 minutes has been returning nothing but zeros for
45 days.

**4. The source's timezone documentation is wrong, and the data is right.** DOT
states timestamps are captured in EST. They are America/New_York civil time.
The proof: the spring-forward hour 02:00–02:59 has **zero rows on the second
Sunday of March in every year from 2013 to 2026** — fourteen consecutive years,
the whole span of the dataset — the Sundays either side are complete, and each
spring-forward day is short by exactly one hour of quarter-hours (2023: 368 vs
384; 2024: 1104 vs 1152; 2025: 1472 vs 1536; 2026: 1104 vs 1152). A fixed
−05:00 offset cannot produce a missing hour.

**5. The deferred program is the one with coverage.** `cqsj-cfgu` is **114
locations × 111 count columns**, 2007–2026, AM/midday/PM, on retail corridors
plus the East River and Harlem River bridges and the Hudson River Greenway; 50
of the 114 are in the Pedestrian Volume Index. It is 97.3% complete (12 312 of
12 654 cells), every location has been surveyed at least once, and it supports a
long-run direction for all 114: **41 rising, 41 falling, 32 flat, 0
insufficient**.

## Decision

**1. The bi-annual screenline program is the primary layer.** It is published
as `historical-locations.geojson` (114 sites, latest survey, long-run change and
trend) and `historical-patterns.json` (every survey, per site, with the trend
rule written down beside it). Its coverage is what makes a map of anything.

**2. The automated counters are a small, secondary layer, honestly labelled as
stale.** They are published in their own files — `sensors.geojson` and
`latest.json` — because they are a different measurement program in a different
unit, and a `busy` from one is not a `busy` from the other. They are never
summed with the historical figures, never joined to them, and never rendered on
a shared scale. [ADR 0001](0001-freeze-the-location-schema.md) governs the walk
contract the same way it governs the location contract.

**3. Freshness is derived, never taken from the source.** `status` is `raw` for
all 1 505 220 pedestrian rows — the vocabulary is real (bike rows do use
`modified`) but the value is constant, exactly like `license_status: Issued` in
`fpeh-f7ci`. So `staleness` is computed from the age of the newest observation:
`fresh` within 6 h, `stale` within 24 h, `offline` past that. `status` is not
published as a health signal and is not a filter, because a one-value filter is
a lie. `lastdata` in the sensor metadata is not used either: it is 100 days
stale for both Willis Ave rows, and freshness is derived from the counts.

**4. The twin sensor ids are never summed.** The published id is keyed on the
physical `counters_serial` (`_common.sensor_id()` = `wsk-` + `sha1(serial)[:12]`),
identity is resolved in **two passes** — group on serial, then merge groups that
are the same site under two serials — and exactly one representative source id
per counter is summed in + out. `validate_walk.py` asserts four twin invariants
(I1 no shared serial, I2 every source id in exactly one feature, I3 the
published `count` recomputed from the raw rows, I4 the twin-unaware aggregate
equals `count × len(sensorIds)`), so a build that double-counts fails rather
than publishing.

**5. The counters are treated as a batch, and refreshed once a day.** The
workflow runs daily, not every six hours, because the measured ingestion lag is
~7.6 h and the payload is a daily publish: a 6-hourly schedule would mostly
re-fetch byte-identical data and burn Actions minutes to learn nothing. The UI
shows the age of the newest observation and never the word "live".

**6. Timestamps are read as New York civil time, in both halves.** The
pipeline localises with `America/New_York` and never applies a second offset.
The autumn fall-back hour is a documented, unquantifiable loss: the ETL
collapsed the repeated 01:00 hour, so one physical hour of counts is absent once
a year on every sensor, and the source cannot tell us which occurrence survived.

**7. The source's two column-spelling and borough hazards are handled by
publishing verbatim and warning, never by repairing.**

- `cqsj-cfgu` spells its survey columns three ways in one row (`may_07_am`,
  `may26_pm`, `may_22_p_m` — the last two are labelled `May22_pM`/`May23_pM` by
  DOT). A regex understanding two of them silently drops **224 populated
  observations** (112 sites × 2 surveys). All 111 columns are consumed, the
  third spelling maps onto `pm`, and a deliberately broader shape-detector
  asserts that every survey-shaped column was consumed, so a **fourth** spelling
  is caught rather than dropped.
- `borough` in that dataset is not a borough: 19 of 114 sites carry a waterway
  name (`Harlem River Bridges` 9, `East River Bridges` 5) and 5 carry a
  truncated **`Staten Isla`**. Rejecting drops 19 real hand-counted bridge
  sites over a naming problem; "repairing" would need a bridge-to-borough table
  the city never published, so every row of it would be a guess presented as a
  citation. So the value is published verbatim, counted in
  `report.pipeline.nonBoroughBoroughValues`, and warned about by the validator.

## Alternatives considered

### Ship the automated counters as the MVP, as planned

- Pros: it is the "live" layer; a daily-updating map sounds like the more
  compelling product.
- Cons: 67 rows read as coverage is 4 counters. One has not reported in over a
  year, another for nearly four months, and a third reports only zeros.
- Rejected by the measurement: the MVP would have been a two-dot map in which
  one dot was a dead counter labelled confidently. Deferring the 114-site
  program was the actual mistake; the fix is to invert the plan, not to ship it.

### Publish the historical program only and drop the counters for now

- Pros: one program, one unit, 114 sites, no staleness problem at all. The
  simplest honest thing to build.
- Cons: throws away a genuine measurement program, and 1.5M real pedestrian
  observations, over a feed problem that labelling solves.
- Rejected: it trades a fixable presentation problem for missing data. The
  counters are published with derived freshness and a fault-aware label, which
  is a smaller change than deleting the half — and the historical-only version
  stays available as the documented fallback (see the consequences).

### Key the published id on the source's own `sensor_id`

- Pros: it is the key the city publishes; no derived identity at all; a reader
  can join our output to theirs with one join.
- Rejected: it is the bug. Four physical counters become eight features and
  every aggregate doubles — 7 484 824 against a physical 3 742 412. It is also
  not even a unique key in the source: Willis Ave's two ids both carry two
  serials. The derived id is `wsk-` + `sha1(counters_serial)[:12]`, and the
  source ids are kept in `sensorIds` so the join is still possible.

### Sum `in` + `out` for **both** twins and publish eight points

- Pros: nothing collapses, nothing is invented, and the twins agreeing is a
  free consistency check.
- Rejected: it publishes four phantom counters with plausible-looking numbers.
  The twins are the same measurement twice; a map with eight points where there
  are four locations is a picture of the ETL, not of the city.

### Treat the feed as live: poll every 6 hours, or every 15 minutes

- Pros: fresher labels sooner; "live" is what a visitor expects from a map of
  foot traffic.
- Cons: three of every four runs fetch byte-identical data. The measured lag was
  7.6 h on `rowsUpdatedAt` and 14.6 h on the newest pedestrian row, and every
  complete day has exactly 768 rows.
- Rejected: a 6-hourly schedule against a daily publish buys nothing and costs
  four times the Actions minutes. If DOT ever makes this genuinely streaming,
  revisit with the measurement in hand rather than in advance.

### Read the source documentation literally — fixed EST (−05:00)

- Pros: it is what the dataset description says; one constant; no zoneinfo.
- Rejected: the data contradicts it. Fourteen consecutive years of a missing
  02:00 hour is not a coincidence, and under a fixed offset those quarter-hours
  exist every day of the year. Getting it wrong shifts every summer observation
  by an hour against every winter one, moves every time-of-day baseline for half
  the year, and — because staleness compares against the converted instant —
  makes a healthy summer sensor score an hour stale, crossing the fresh/stale
  boundary daily for seven months. The pipeline still degrades gracefully: if
  the host has no tz database it falls back to −05:00 and says so in the report
  rather than doing it silently.

### Use `status`, or `lastdata`, as the freshness signal

- Pros: both are named columns, which is the project's core promise.
- Rejected: `status` is `raw` for all 1 505 220 pedestrian rows, and `lastdata`
  is 100 days stale for both Willis Ave rows. Publishing either as a health
  signal would be a confident wrong answer derived from a real column, which is
  worse than having no column.

### Repair the source's dirty values — `Staten Isla` → `Staten Island`, bridges
→ boroughs

- Pros: a clean five-borough filter, and no odd-looking strings in the UI.
- Cons: the bridge-to-borough mapping is not published anywhere in this
  pipeline's sources, so all 19 rows of it would be guesses wearing a citation
  — the exact failure this project exists to avoid.
- Rejected: publish verbatim, count it, warn about it. Nothing keys on the
  literal string of a known-odd value, so if DOT fixes `Staten Isla` tomorrow
  it publishes cleanly and the counter simply moves.

### Accept the two common column spellings, and widen the regex when a third
appears

- Pros: the simplest possible rule, and no second mechanism to maintain.
- Cons: it fails silently. Two spellings drops 224 populated observations with
  an error nowhere, and every future widening is a change made *after* the data
  has already been lost.
- Rejected: the third spelling is mapped onto `pm`, and a separate, deliberately
  broader shape-detector asserts that every survey-shaped column was consumed.
  The detector, not the regex, is what stops a fourth spelling from vanishing.

### Rank the four counters, or compare boroughs

- Pros: it is the obvious thing a visitor would ask for, and it would make the
  map more interesting.
- Rejected on arithmetic: the nearest pair of counters is 3 993 m apart and the
  furthest 28 648 m; the two programs share **no co-located pair at all** (the
  nearest automated sensor to any screenline is 624 m). The automated program
  has two counters in the Bronx — one of them stuck at zero — one in Brooklyn,
  one in Manhattan, and none in Queens or Staten Island. There is nothing to
  rank against. This is the
  "best of" list that [`contributing.md`](../contributing.md#what-not-to-add)
  already forbids, and the coverage is a second, independent reason.

### Drop the activity labels and publish raw counts

- Pros: no baseline, no `MIN_SAMPLES`, no zero-median special case, no stale
  label to be wrong about.
- Cons: the medians are 1, 2, 3 and 16 people per 15 minutes, and the four
  counters have no comparable scale. A raw number is uninterpretable and a
  shared colour scale keyed to it would paint one counter permanently saturated
  and another permanently pale — both right about their own street.
- Rejected: the label is relative to the sensor's own history, which is the only
  scale the data supports. `ratio` is published next to it for anyone who wants
  the magnitude.

## Consequences

- **The primary layer is one with coverage.** 114 locations, 19 years, a trend
  for every site, and a source that has published a new survey every few months
  for two decades.
- **The secondary layer is thin, and it might not earn its keep.** Four points,
  two of them `stale`, two `offline`, `active: false` on all four at the last
  build, and the one counter still emitting rows has been stuck at zero for 45
  days. This is a real risk, not a hypothetical one, and the honest response is
  to name it: **if the feed does not recover, the automated layer gets dropped**
  — `sensors.geojson`, `latest.json`, the counters half of the pipeline and
  `refresh-walk-data`'s sensor stage all go, the historical-only fallback above
  is what ships, and the README and this ADR's status get updated. A two-point
  layer that mostly says "no recent reading" is worse than no layer.
- **The counters cannot be silently doubled.** Two-pass identity resolution and
  four asserted twin invariants turn a 2× error that looks plausible into a
  failed build.
- **Freshness is honest, which sometimes means the map is mostly empty.** At the
  last build every counter was outside the 6-hour window. `unavailable` and
  `offline` are the correct answers for those, and a `count` on an offline
  counter is a validation error, not a display state.
- **A degraded or short fetch publishes `unavailable` rather than a guess.**
  `MIN_SAMPLES` is 7, the observed floor of the 56-day window: 1 227 of the
  1 344 baseline keys have 8 observations and 117 have exactly 7, where the
  window boundary lands mid-day (the pipeline's own note records 1 241/103 on
  an earlier snapshot of the same day — the split moves with the window edge).
  It started at 4, which was wrong in a way worth recording: `percentile_rank`
  credits half the ties, so the highest percentile any observation can reach is
  `100 − 50/n`, and at n = 4 that is 87.5 — `veryBusy` (p ≥ 90) was **structurally
  unreachable**, and the label silently degraded to "new record".
- **The baseline rolls, because a static one would be wrong.** It is a trailing
  56-day window keyed on (weekday, 15-minute bucket) in New York civil time, and
  it excludes the observation being measured. September runs 1.5× to 2.7×
  January at the same weekday and the same time of day; an all-time baseline
  would compare September against January forever, and it could never recover
  from a counter fault.
- **Reading timestamps as civil time inverts every summer timestamp** relative
  to the earlier fixed-offset code. That is a visible change to already
  published data, and it is the correct one.
- **The two halves have two incompatible vocabularies on one screen.** A
  `busy` screenline from 2026 and a `busy` sensor from this morning are two
  different words. They are never summed, never normalised against each other,
  and the UI must not present them on a shared scale or a shared legend without
  saying which is which.
- **The fault gate arrived as its own decision, not with this one.** A counter
  that reports a row every 15 minutes with every reading `0` is caught by nothing
  except the zero-median branch, which publishes it as `quiet` — the honest
  floor, and not the right answer for a dead sensor, and worse than that once
  `active` is derived from freshness. The all-zero-run detector is
  [ADR 0007](0007-fault-a-counter-publishing-zeroes-is-not-fresh.md), which adds
  a fifth staleness state. The `direction`-split detector the analysis also
  recommends is still not implemented, and deliberately so: there is no case of
  one in the committed snapshot to tune it against. See the open questions in
  [`walk-data-analysis.md`](../walk-data-analysis.md#open-questions-for-the-maintainer).
- **The daily gate has a known blind spot on the historical half.** Its
  `contentHash` covers `historical-locations.geojson` only, so a fix to an older
  survey column that no site's *latest* survey depends on changes
  `historical-patterns.json` and does **not** move the hash. The workflow's
  second, timestamp-stripped comparison is what catches it — see
  [ADR 0002](0002-hash-features-never-the-timestamp.md).

## What would make us revisit this

- **The automated feed recovers**: a fifth pedestrian counter appears, or two or
  more counters publish `active: true` for a sustained period, or the batch
  becomes genuinely sub-daily. That is the signal to promote it back to a
  co-equal layer, and it would come with a re-measurement, not an assumption.
- **The automated feed does not recover.** Two more quarters with the feed in
  this state is enough to treat "four counters, mostly dead" as the answer, and
  to drop the layer rather than maintain it honestly.
- **DOT publishes a pedestrian dataset we have not read.** The historical
  program proves DOT can count 114 locations when it chooses to, so "four
  counters" is a fact about these two datasets and not necessarily about the
  city. One hour of searching is worth spending before this is permanent.
- **`Staten Isla` is corrected upstream**, or a bridge-to-borough column
  appears. Then the verbatim publishing can be replaced by a real mapping — with
  an ADR, because it is a change to what a published field means.
- **The sensors half is dropped** and only the historical program ships. That
  supersedes this one rather than editing it.

## Where this lives

- Decision index: [`docs/decisions.md`](../decisions.md)
- Reader-facing methodology: [`docs/where-nyc-walks.md`](../where-nyc-walks.md)
- The measurements, with every query:
  [`docs/walk-data-analysis.md`](../walk-data-analysis.md)
- Contract: [`src/types/walk.ts`](../../src/types/walk.ts) —
  `src/features/registry.ts`
- Pipeline: [`scripts/walk/_common.py`](../../scripts/walk/_common.py) —
  identity, time, activity, staleness — and
  [`scripts/walk/history/transform.py`](../../scripts/walk/history/transform.py)
  for the screenline half
- Refresh: [`.github/workflows/refresh-walk-data.yml`](../../.github/workflows/refresh-walk-data.yml)
- Tests: [`tests/python/test_walk_sensors.py`](../../tests/python/test_walk_sensors.py),
  [`test_walk_history.py`](../../tests/python/test_walk_history.py),
  [`test_walk_timestamps.py`](../../tests/python/test_walk_timestamps.py)
