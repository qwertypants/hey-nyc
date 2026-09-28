# Decisions

Every decision this project has made that is expensive to reverse, and the
reasoning behind it. **Read this before you change anything.** It is short on
purpose.

If you are an agent or a new contributor, this file is the first thing to open
after `AGENTS.md`. It exists so you can *recall* a decision instead of
re-deciding it, and so you can tell a settled question from an open one.

Git history records what changed. This records **why**, which git cannot.

## The decisions in force

The short version. Read the ADR when the change you are making touches it.

| # | Decision | Status | Date |
| --- | --- | --- | --- |
| [0001](adr/0001-freeze-the-location-schema.md) | [Freeze the location schema](adr/0001-freeze-the-location-schema.md) — `src/types/location.ts` and the Python pipeline are two implementations of one contract and move together | Accepted *(retroactive)* | 2026-09-27 |
| [0002](adr/0002-hash-features-never-the-timestamp.md) | [Hash the features, never the timestamp](adr/0002-hash-features-never-the-timestamp.md) — `contentHash` covers the published records only, so the daily refresh can tell a real change from a re-run | Accepted *(retroactive)* | 2026-09-27 |
| [0003](adr/0003-keyless-basemap-three-runtime-deps.md) | [A keyless basemap and three runtime dependencies](adr/0003-keyless-basemap-three-runtime-deps.md) — OpenFreeMap via one env var; `maplibre-gl`, `react`, `react-dom` and nothing else ships | Accepted *(retroactive)* | 2026-09-27 |
| [0004](adr/0004-record-decisions-as-adrs.md) | [Record decisions as ADRs, recalled from an index](adr/0004-record-decisions-as-adrs.md) — this file, `docs/adr/`, `AGENTS.md`, and the trigger list below. Docs only, no CI gate | Accepted | 2026-09-27 |
| [0005](adr/0005-google-maps-directions-handoff.md) | [Hand directions to Google Maps over a web URL](adr/0005-google-maps-directions-handoff.md) — the "Directions" link opens a key-free Maps URL, because `geo:` is a dead click on desktop | Accepted | 2026-09-28 |
| [0006](adr/0006-lead-with-the-bi-annual-counts-not-the-live-feed.md) | [Lead with the bi-annual counts, not the live feed](adr/0006-lead-with-the-bi-annual-counts-not-the-live-feed.md) — Where NYC Walks is led by DOT's 114-site screenline program; the 4-counter automated feed is a secondary layer with derived freshness, and its twin sensor ids are never summed | Accepted | 2026-09-28 |

0001–0003 are marked *retroactive*: those decisions were made and reasoned on
2026-09-27 and written down afterwards, reconstructed from commit `9c18edd` and
the documents that shipped with it. Nothing about the decisions changed in
between.

## When you need a new ADR

Write one **before** you write the code, if your change is any of these:

- **A new runtime npm dependency**, or a new Python dependency in the pipeline.
- **A contract change** — any non-additive edit to `src/types/location.ts`, a
  field name, type, meaning, or the set of allowed values. See
  [ADR 0001](adr/0001-freeze-the-location-schema.md) and
  [`contributing.md`](contributing.md#the-frozen-contract).
- **Touching `content_hash()`, `ID_RE`, `PROPERTY_ORDER` or `SCHEMA`.** These are
  the load-bearing definitions; changing one has effects that are not local. See
  [ADR 0002](adr/0002-hash-features-never-the-timestamp.md).
- **A second feature kind in `cafes.geojson`, or a second NYC Open Data
  layer.** The filename is part of the contract. See
  [`data-pipeline.md`](data-pipeline.md#adding-a-new-nyc-open-data-layer), and
  [ADR 0006](adr/0006-lead-with-the-bi-annual-counts-not-the-live-feed.md) for
  the one that has been done.
- **A change to the basemap, the geocoder, or the data source.** See
  [`basemap.md`](basemap.md).
- **Relaxing anything in "What not to add"** in
  [`contributing.md`](contributing.md#what-not-to-add) — ratings, hours, menus,
  prices, cuisines, photos, rankings, recommendations, AI features, accounts,
  cookies, analytics, tracking, proprietary data, or a vendored basemap style.

Anything else is an issue or an ordinary pull request. Do not write an ADR for a
bug fix, a UI tweak, a test, or a data refresh — a record that includes
everything is a record nobody reads.

## Writing one

Copy the shape of an existing ADR. The sections are:

```markdown
# NNNN. Title in the imperative

**Status:** Proposed | Accepted | Accepted (retroactive) | Superseded by NNNN
**Date:** YYYY-MM-DD

## Context
The situation, with the numbers. What made this a decision rather than a
default.

## Decision
What was chosen, and what it means concretely — including the files that have
to move together.

## Alternatives considered
### The option
- Pros:
- Cons:
- Rejected: <the reason, with the measurement if there was one>

## Consequences
What gets harder, what is now forbidden, and what would make this worth
revisiting.
```

Four rules:

1. **The alternatives section is the point.** Name what was rejected and, where
   there was one, the measurement that rejected it. An ADR with no alternatives
   is a comment with a date on it.
2. **Never delete an ADR.** To change a decision, write a new one, set this
   old one's status to `Superseded by NNNN`, and add a row to the table above.
3. **Link both ways.** Name the files the decision governs, and add a
   `see docs/adr/NNNN` reference in the code it governs.
4. **Write the consequence that is inconvenient.** A decision with only upsides
   in it has not been examined.

Filenames are `NNNN-kebab-title.md`, four digits, no prefix. The number is never
reused.

## What is not here

Not everything in `docs/` is a decision, and this index does not try to be.

- **Rules and their enforcement** — lint, tests, commit format, the PR process.
  Those are [`contributing.md`](contributing.md). A rule is an instruction; a
  decision is a choice with rejected alternatives. Some rules exist only because
  of a decision, and those rules link here.
- **Runbooks** — how to fetch, clean, validate, deploy, and what to do when each
  one breaks. [`data-pipeline.md`](data-pipeline.md).
- **The schema itself** — what each field means and what the current numbers
  are. [`data-dictionary.md`](data-dictionary.md).
- **The walk methodology** — what a sensor reading is, how the activity labels
  and the freshness states are derived, and what the pedestrian data cannot say.
  [`where-nyc-walks.md`](where-nyc-walks.md), with the measurements behind it
  in [`walk-data-analysis.md`](walk-data-analysis.md).
- **Data refreshes.** The `data:` commits are the bot's, and they are not
  decisions.
