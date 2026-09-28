# AGENTS.md

Operating rules for AI agents and new contributors working on **Eat Outside
NYC** — a map of NYC establishments participating in the Dining Out NYC
programme, built from NYC Open Data `fpeh-f7ci`.

## The one thing to understand first

**Every field on screen came from a named column in a named public dataset.**

That is the core promise, and it is load-bearing. The source has no ratings, no
hours, no menus, no prices, no cuisines and no photos. If you are tempted to add
one, you are not inventing a feature — you are inventing data. The
consequences are enumerated in
[`docs/contributing.md`](docs/contributing.md#what-not-to-add), and the
reasoning is in
[ADR 0003](docs/adr/0003-keyless-basemap-three-runtime-deps.md).

The second half of the promise: **this is forkable in one click.** No accounts,
no API keys, no secrets, no proprietary data source, no backend. A change that
needs any of those does not belong in this repository.

## Read before you change anything

1. **This file.**
2. **[`docs/decisions.md`](docs/decisions.md)** — the decision index. Short.
   Read it to *recall* rather than re-decide, and to tell a settled question
   from an open one.
3. The ADR(s) for the area you are touching, from the table in `decisions.md`.
4. [`docs/contributing.md`](docs/contributing.md) — the rules. It is the human
   contract; where it and this file disagree, it wins.

Do not restate a rule from `contributing.md` into code you write. Link to it.
One source of truth, or none.

## Decisions in force

| # | Decision | Read it when you are about to |
| --- | --- | --- |
| [0001](docs/adr/0001-freeze-the-location-schema.md) | The location schema is one contract across two languages | change a field name, type, meaning or allowed value |
| [0002](docs/adr/0002-hash-features-never-the-timestamp.md) | `contentHash` covers published features, never a timestamp | touch `content_hash()`, the id recipe, or the refresh workflow |
| [0003](docs/adr/0003-keyless-basemap-three-runtime-deps.md) | OpenFreeMap via one env var; three runtime deps; standard-library pipeline | add a dependency, swap the basemap, or add geocoding |
| [0004](docs/adr/0004-record-decisions-as-adrs.md) | Decisions are ADRs, recalled from an index. Docs only, no CI gate | change the process itself |
| [0005](docs/adr/0005-google-maps-directions-handoff.md) | The "Directions" link hands off to a key-free Google Maps URL, because `geo:` is a dead click on desktop | change the directions handoff, or act on "no Google" in the Never list below |

## Verify

```bash
npm run verify      # lint + test + build + data:validate --strict + pytest
npm run test:data   # pytest, no network
```

`npm run verify` is `ci.yml` in the same order — the app job's lint, test and
build, then the data job's strict validation and Python tests. If it passes
locally, CI passes. The one difference is that `ci.yml` runs
`npm run typecheck` as its own named step, which `npm run build` already
performs via `tsc --noEmit`.

There is **no automated formatter** — no Prettier dependency and no config. Do
not "fix" formatting as a side effect of another change; match the surrounding
file by hand. `npm run lint` and `npm run typecheck` are the only automated style
gates.

There are 457 TypeScript tests and 212 Python tests. Both suites run in well
under a second. **Every behaviour change needs a test that would fail without
your change** — not "the existing tests still pass".

## The frozen contract

`src/types/location.ts` and `scripts/_common.py` are two implementations of one
schema, and nothing at runtime ties them together.

**If you change a field name, a field type, the set of allowed values, the
property order, or the id recipe, you change both sides in the same pull
request.** One side alone is a broken build at best and silent data corruption
at worst.

Adding an optional, nullable property the UI does not depend on is additive and
cheap. Anything else is a contract change. The six files that must move, and the
full rule, are in
[`contributing.md` → The frozen contract](docs/contributing.md#the-frozen-contract)
and [ADR 0001](docs/adr/0001-freeze-the-location-schema.md).

**Never change `content_hash()` casually.** It is what the daily workflow compares
to decide whether upstream data actually changed. Changing it makes every refresh
look like a data change — a commit a day and a deploy a day, forever. See
[ADR 0002](docs/adr/0002-hash-features-never-the-timestamp.md).

**Never hand-edit anything under `public/data/` or `data/processed/`.** Those are
generated. Change `scripts/clean_data.py`, rerun `npm run data:clean`, commit all
three artifacts together.

## Never

These are consequences, not preferences. Do not add them, and do not relax one
without a new ADR.

- **No ratings, reviews, scores, hours, menus, prices, cuisines, photos or
  reservation links.** The source has none. Anything here would be invented or
  scraped.
- **No recommendations, "best of" lists or ranking.** The app tells you where
  licences exist. It does not tell you where to eat.
- **No AI features** — no generated summaries, no natural-language search over
  descriptions, no embeddings.
- **No accounts, sign-in, cookies, analytics or tracking.** This is why there is
  no backend.
- **No proprietary, scraped or gated data source.** No Mapbox token, no Google,
  no paid geocoder, no Yelp or Google Places. "No Google" means no Google
  *data* — no key, no account, no SDK, no Places, nothing rendered from
  Google's response. A plain outbound link is not data and is covered by
  [ADR 0005](docs/adr/0005-google-maps-directions-handoff.md).
- **No vendored basemap style JSON.** It is the thing that makes MapLibre drop
  the OpenStreetMap attribution.
- **No new runtime npm dependency** without an ADR arguing the standard library
  and the existing three are not enough. **No new Python dependency** in the
  pipeline at all — it is standard library only, deliberately.
- **No `console.log`, no `@ts-ignore`, no unchecked non-null assertion.**
  `console.warn` and `console.error` are allowed; the map layer legitimately
  reports tile and geocoding problems.
- **No barrel files, no `index.ts` re-exports.** Import the module you mean.
- **No hand-picked basemap tiles.** The style URL is the only seam.

If a task genuinely requires one of these, stop and open an issue. Do not build
it in the same pull request as the thing that wanted it.

## When to write an ADR

Before writing the code, if your change is: a new runtime or pipeline
dependency · a contract change · a touch to `content_hash()`, `ID_RE`,
`PROPERTY_ORDER` or `SCHEMA` · a second feature kind in `cafes.geojson` or a
second NYC Open Data layer · a change to the basemap, geocoder or data source ·
or a relaxation of anything in the **Never** list above.

Everything else is an issue or an ordinary pull request. Do not write an ADR for
a bug fix, a UI tweak, a test, or a data refresh.

The full trigger list, the template and the four rules are in
[`docs/decisions.md`](docs/decisions.md). An ADR is `docs/adr/NNNN-kebab-title.md`,
numbered and never reused, and **it is never deleted** — to change a decision,
supersede it.

## Working on the data pipeline

Changing the pipeline changes 2 000 published records, so it gets a higher bar
than a UI change.

1. `npm run data:inspect` before and after, and paste both in the pull request.
2. `git diff --stat -- public/data data/processed` plus the `report.json`
   counters, with an explanation of any change in the published counts.
3. **Never repair data silently.** Anything the pipeline changes is counted in
   `report.pipeline`; anything it drops is listed in `report.rejections` with a
   reason.
4. **Keep rules derived from evidence.** Cite the rows that motivated a new
   validation rule. Do not add one because it seems sensible.
5. If `SCHEMA` in `validate_data.py` moves, say whether the pipeline changed or
   the world changed.

The runbook, including the merge rules, the id recipe and what to do when it
breaks, is [`docs/data-pipeline.md`](docs/data-pipeline.md).

## Commits and pull requests

Conventional Commits, lowercase scope, short subject:

```
feat: add borough filter to the sidebar
fix: treat a missing nta as null instead of an empty string
docs: explain why postcode is not a validation gate
test: cover the ambiguous_license_group rejection
refactor: extract the bbox check from merge_groups
```

**`data:` is reserved for the refresh bot. Never use it by hand.**

Open an issue before a pull request for anything larger than a bug fix. Branch
from `main`, one topic per branch. Fill in the template — the frozen-contract and
decision questions are the parts that matter, and tick them honestly rather than
optimistically.

## Layout

```
src/
  components/   UI. No barrel files.
  data/         dataset.ts loads and runtime-validates the artifacts
  lib/          pure functions, one concern per file, unit-tested
  map/          MapLibre layers over the GeoJSON we control
  types/        location.ts — the frozen contract. Read the header comment.
scripts/        Python pipeline. Standard library only. Importable and runnable.
tests/          vitest. python/ for the pipeline. helpers/ and setup.ts.
docs/           Documentation. adr/ holds the decision records.
public/data/    GENERATED. Never hand-edit.
data/           raw snapshot (git-ignored) and processed/report.json.
```

## Working with this repository in parallel

If you are running several agents over the same repo, give each one its own git
worktree and its own branch. The refresh bot commits to `main` daily, and two
agents editing `public/data/` or the pipeline in the same tree will collide on
artifacts neither of them knows the other regenerated.
