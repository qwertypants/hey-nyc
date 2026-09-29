# 0007. A counter that publishes zeroes is not a counter reporting

**Status:** Accepted
**Date:** 2026-09-28

## Context

[ADR 0006](0006-lead-with-the-bi-annual-counts-not-the-live-feed.md) chose to
publish the 4-counter automated feed as a secondary layer rather than delete it,
and justified that partly on the counters being published "with derived
freshness and a fault-aware label". No fault gate existed. This ADR is the
decision that makes the second half of that sentence true.

Freshness was, and still is in three of its five states, a function of the age
of the newest observation:

    FRESH_WITHIN = 30 hours      # one batch cycle; DOT writes this data daily
    STALE_AFTER  = 7 days

That is correct as far as it goes, and it cannot be extended to cover a fault,
because a fault is not a property of the clock. Measured on the 2026-09-28
snapshot — 57 days of pedestrian rows, over the two counters that publish at all:

| Counter | Rows | Zero rows | Nonzero days | Longest run of days with no nonzero reading |
| --- | --- | --- | --- | --- |
| Concrete Plant Park | 10 634 | 10 012 | 6 of 57 | **45** |
| Emmons Ave | 10 636 | 4 357 | — | **1** |

Concrete Plant Park emits its full quarter-hourly grid, 192 rows a day, every
reading `0`, for 45 consecutive days. Its newest row is an hour old. By recency
it is the *freshest* thing in the dataset.

That combination is what made the gap expensive rather than cosmetic, because
`active` is derived from `staleness`. The published artifact read:

    "active": true, "staleness": "fresh", "activity": "quiet", "count": 0

A dead counter, drawn on the map as a live, empty park, with a real number next
to it. Every individual field was true. The sentence they formed was a lie, and
it was the most plausible wrong answer the data permitted — a reader has no way
to tell an empty park from a broken instrument without opening the detail sheet.

The other trigger for needing a decision now rather than later: the published
`count` is not merely unreliable for a faulted counter, it is *structurally*
meaningless. A blip above a bucket whose historical median is 0 scores
`100 − 50/n` on `percentile_rank`, the maximum the tie-credit formula can
return, so the ladder would publish `veryBusy` — the strongest available claim —
out of a distribution with zero variance and no upper support. `activity_for`
already special-cases the zero-median bucket to prevent that, but it is a
presentation guard, not a health check: it says "no level is available here"
about a *bucket*, and says nothing about a *counter* that has been empty for
45 days.

## Decision

Add a fifth staleness state, `faulted`, and fire it from a run detector rather
than from any count.

    FAULT_ZERO_DAYS = 7

A counter is `faulted` when it is `fresh` by age **and** the last 7 or more
consecutive New York civil days each contain observations and **no nonzero
reading anywhere in them**. It is checked only against `fresh`; a counter that has
gone silent is `offline`, and that is the age buckets' claim to make.

Concretely:

- `scripts/walk/_common.py` owns `FAULT_ZERO_DAYS`, `fault_run_days()` and
  `is_faulted()`. `staleness_for()` is **not** modified: it answers a different
  question and its tests still describe it correctly.
- `src/types/walk.ts` adds `'faulted'` to `STALENESS_STATES`. Both halves move
  in the same commit, per
  [ADR 0001](0001-freeze-the-location-schema.md).
- `SENSOR_PROPERTY_ORDER` does **not** change. This is a new allowed value on an
  already-published field, not a new field, so it is additive.
- `active` stays derived (`staleness == 'fresh'`), which makes a faulted counter
  inactive for free. The validator's existing invariant covers it.
- The counter's **last measurement is still published** — `count: 0` and
  `observedAt` survive — as they do for `offline`. What is withheld is the
  belief in it: `staleness` says faulted, and the headline sentence says the
  counter is reporting zeroes rather than "Last reading 14 hours ago".
- On the map, `faulted` prints a **`0`** in a hollow ring. `offline` and
  `unavailable` keep the `x` they share.

Two properties of the detector are deliberate and separately tested:

- **A day with no rows is a gap, not a zero day**, and terminates the run instead
  of extending it. Otherwise a counter that stopped reporting would drift toward
  `faulted` and be described as a counter that is reporting zeroes — trading one
  confident wrong answer for another.
- **The threshold is set on the healthy counter's noise floor (1), not on the
  failed one's (45).** `7` is an order of magnitude from both, but the direction
  of the error is what matters: a threshold at or below 1 would flag a *working*
  sensor on a quiet day, and that false positive costs a real counter its label
  every time the weather turns. A missed fault degrades to the `quiet` label we
  had before; a false fault deletes a good counter from the live set.

## Alternatives considered

### Add `faulted` as an ACTIVITY state rather than a staleness state

- Pros: `SENSOR_ACTIVITIES` already carries `unavailable`, described as "a state,
  not a level of activity", so there is precedent for a non-level in that enum.
- Cons: `activity` is a claim about the *street* — `quiet` says the path is
  empty. A fault is a claim about the *counter*, and putting it there would make
  the field mean two different things in the same row. It would also leave
  `active: true` on a dead counter, because `active` is derived from staleness.
- Rejected: it publishes the right word attached to the wrong axis, and leaves
  the map marker live.

### Reuse `offline`, and treat "reporting zeros" as a kind of dead

- Pros: no new value in a frozen set; the counter is, for practical purposes,
  contributing nothing.
- Cons: collapses a fact the source does state. `offline` means the source has
  gone quiet, and "Offline since 7 June" is a statement about when it stopped.
  For a counter that spoke 40 minutes ago, that sentence is false, and the
  existing wording would print a date implying silence that never happened.
- Rejected: the two states have opposite evidence — silence versus a heartbeat
  of zeroes — and the existing `offline` wording asserts the silence.

### Exclude a faulted counter from `sensors.geojson` entirely

- Pros: the map cannot mislead if the feature is not on the map.
- Cons: deleting a row is irreversible from a reader's point of view and hides
  the fact that a counter exists and is broken. It also throws away the shape of
  the evidence. And the same argument, taken to its end, would justify deleting
  the two `offline` counters too, which would leave two dots.
- Rejected: an honest label is cheaper than a silent hole, and the repository's
  standing rule is that a missing thing is never published as a measurement.

### Gate on the trailing `|in − out| / (in + out)` ratio instead

- Pros: the analysis reports this separates cleanly, and it would catch a
  lopsided split that the all-zero run cannot — a counter stuck on one direction
  is not stuck on zero.
- Cons: **there is no case of one in the committed snapshot.** Any constant
  would be chosen without a measured false-positive rate against a counter that
  was genuinely busy.
- Rejected for now, deliberately and with the reason written down rather than
  silently: this is the same error as `MIN_SAMPLES` at 4, where
  `percentile_rank`'s tie credit made `veryBusy` structurally unreachable. An
  untuned constant is worse than a missing feature, because it looks tuned.
  The ratio is the next detector, not this one.

### Lower `FRESH_WITHIN` so a dead counter ages out

- Pros: no new state; a smaller change.
- Cons: it cannot work. A counter emitting 192 rows a day is never older than
  one batch cycle, so no recency threshold short of "always stale" can catch it,
  and "always stale" is a lie about the other three counters.
- Rejected: rejected by the data, not by taste.

## Consequences

What gets harder:

- `STALENESS_STATES` is now a five-value enum on both sides, and every consumer
  that switches on it must handle a state that means "the count is not real".
  The `Record<Staleness, StalenessStyle>` in `style.ts` and the
  `stalenessSentence` cases in `wording.ts` are the two places a new state is
  easy to forget, and both are asserted at compile or test time.
- The `0` glyph is a third character in the mark vocabulary. It is in the
  `Noto Sans` stack the basemap serves, and `tests/walk-display.test.ts` asserts
  the whole vocabulary stays ASCII, but a future state must not assume it can
  reach for any character it likes.
- The threshold is a published judgement, not an implementation detail. It is in
  the contract so that `build_sensors`, the validator and the docs cannot
  disagree, and re-measuring it means re-measuring both counters.

What is now forbidden:

- **Reading `faulted` as "quiet".** The zero-median branch in `activity_for`
  returns `quiet` for a zero count in a zero-expected bucket, and for a faulted
  counter that is the correct *activity* — the bucket really is empty. It is
  `staleness` that carries the fault, and no consumer may collapse the two.
- **Extending the gate to `stale` or `offline`.** It is deliberately only
  checked against `fresh`; a counter that has gone silent is not "reporting
  zeroes".

What would make this worth revisiting:

- A fifth counter in a `faulted` state. At that point the question stops being
  how to label one broken instrument and starts being whether publishing a
  secondary layer of four points is worth the maintenance, which is ADR 0006's
  decision and not this one's.
- The `direction`-split detector, once a real case exists in a snapshot to tune
  it against.
- `MIN_SAMPLES` arithmetic changing under `percentile_rank`, which would change
  what a "typical" bucket means and could change the faulted/fresh boundary too.
