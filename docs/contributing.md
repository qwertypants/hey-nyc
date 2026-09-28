# Contributing

Thanks for looking. This is a small project with a narrow idea, and the bar for
a change is mostly "is it true, and does it still hold together?" rather than
"is it clever".

Read this before you write code. The most important section is
[The frozen contract](#the-frozen-contract), because breaking it is the one way
to make a change that looks harmless and is not.

## Contents

- [Setup](#setup)
- [The frozen contract](#the-frozen-contract)
- [Code style](#code-style)
- [Tests](#tests)
- [Data-change etiquette](#data-change-etiquette)
- [What not to add](#what-not-to-add)
- [Decisions](#decisions)
- [Pull request process](#pull-request-process)
- [Commit messages](#commit-messages)
- [Reporting a problem instead of fixing it](#reporting-a-problem-instead-of-fixing-it)

## Setup

**Prerequisites**

| Tool | Version |
| --- | --- |
| Node.js | >= 20.19 (the `engines` field in `package.json` is the source of truth) |
| Python | 3.11+, 3.12 in CI |
| npm | ships with Node |

**Fork and clone, then:**

```bash
npm install
python3 -m pip install -r requirements.txt
```

**Run the app.** The published artifacts are committed, so you do not need the
network for UI work:

```bash
npm run dev
```

**Run the pipeline.** Only needed if you are touching `scripts/`:

```bash
npm run data:refresh
```

**Check everything before you push:**

```bash
npm run verify            # lint + test + build + data:validate --strict + pytest
```

`npm run verify` is what `ci.yml` runs on your pull request, in the same order:
the app job's lint, test and build, then the data job's
`validate_data.py --strict` and its Python tests. If it passes locally, CI will
pass. The two differences are cosmetic by comparison — `ci.yml` names
`npm run typecheck` as its own step, which `npm run build` already does via
`tsc --noEmit`, and it runs its two jobs in parallel rather than in sequence.

**No secrets, no accounts, no API keys.** If a change requires one, that change
does not belong in this project.

## The frozen contract

`src/types/location.ts` and the Python pipeline are two implementations of one
schema. They are not allowed to disagree, and nothing enforces that at runtime
except CI.

```
scripts/_common.py  PROPERTY_ORDER, PROPERTY_TYPES, ID_RE, DINING_TYPES, BOROUGHS
        |  writes
        v
public/data/cafes.geojson  +  metadata.json  +  report.json
        |  asserted by
        v
scripts/validate_data.py  <->  src/types/location.ts
        |  asserted by
        v
src/data/dataset.ts  validateCollection() / validateMetadata()  (browser)
```

**The rule: if you change a field name, a field type, the set of allowed values,
the property order, or the id recipe, you change both sides in the same pull
request.** One side alone is a broken build at best and silent data corruption at
worst.

Concretely, changing a property means touching, at minimum:

| File | Why |
| --- | --- |
| `src/types/location.ts` | The interface. The human-readable contract. |
| `scripts/_common.py` | `PROPERTY_ORDER` and `PROPERTY_TYPES`. `clean_data.py` asserts the emitted key order against `PROPERTY_ORDER` and will fail loudly if you forget. |
| `scripts/clean_data.py` | Builds `properties`. The dict literal must be in `PROPERTY_ORDER`. |
| `scripts/validate_data.py` | `SCHEMA` and the checks in `check_geojson`. |
| `docs/data-dictionary.md` | The published schema section. |
| Tests on both sides | `tests/data-load.test.ts` and `tests/python/test_geojson.py`. |

**Additive changes are cheap; anything else is a contract change.** Adding an
optional, nullable property that the UI does not depend on is additive and fine.
Renaming, retyping, removing, or changing the meaning of an existing property is
a contract change: expect discussion in the pull request.

**Never change `content_hash()` casually.** It is what the daily workflow compares
to decide whether upstream data actually changed. Changing its definition makes
every refresh look like a data change, which means a commit a day forever and a
deploy a day forever.

**Never hand-edit anything under `public/data/` or `data/processed/`.** Those
files are generated. Edit `scripts/clean_data.py`, rerun `npm run data:clean`,
and commit all three artifacts together.

## Code style

The rules the tooling actually enforces, so you do not have to guess:

- **ESLint** over `src`, `tests` and the config files. `@typescript-eslint`
  recommended plus `react-hooks` recommended. `eqeqeq` with `null` exempted, so
  `x === null` is fine and `x == undefined` is not.
- **`no-console`** is a warning. `console.warn` and `console.error` are allowed
  because the map layer legitimately reports tile and geocoding problems.
  `console.log` is not.
- **Type imports must use `import type`.** Enforced by
  `@typescript-eslint/consistent-type-imports`.
- **`tsc --noEmit` must be clean**, with no `any` escapes, no `@ts-ignore`, and no
  non-null assertion on a value you have not checked.

Beyond what the tools enforce:

- **No automated formatter.** Match the surrounding file by hand. `npm run lint`
  and `tsc --noEmit` are the only automated style gates.

- **Comments explain why, not what.** The pipeline modules are commented
  heavily and almost none of it restates the code. If a line needs a comment
  saying what it does, rename something instead.
- **No barrel files, no `index.ts` re-exports.** Import the module you mean.
- **Keep modules small enough to read in one screen.** `src/data/dataset.ts`
  validates the GeoJSON at runtime; that is a real job and the file is allowed to
  be long, but it is the exception.
- **No new runtime dependencies.** This is a three-dependency app
  (`maplibre-gl`, `react`, `react-dom`) on purpose. A PR that adds one needs to
  argue why the standard library and the existing three are not enough. Adding a
  build-time or dev dependency is a smaller ask but still needs a reason.
- **No new Python dependencies in the pipeline.** `requirements.txt` has exactly
  one entry and it is `pytest`, which is test-only. The pipeline is standard
  library only, deliberately — see the comment at the top of that file.

## Tests

There are 511 TypeScript tests and 212 Python tests. Both suites run in
well under a second, so there is no excuse for skipping one.

- **Every behaviour change needs a test.** Not "the existing tests still pass" —
  a test that would fail without your change.
- **Match the surrounding style.** `tests/lib-*.test.ts` for pure functions,
  `tests/data-load.test.ts` for the loader boundary, `tests/smoke/` for shape
  assertions, `tests/python/test_*.py` for the pipeline with one file per module.
- **Python tests use inline fixtures and never open a socket.** Build a row with
  `conftest.BASE_ROW` and mutate it. The one URL in `test_fetch_data.py` is
  `https://example.invalid` behind a monkeypatched `urlopen`; keep it that way.
  A test that hits the network will be slow, flaky, and rate-limit the city.
- **TypeScript tests use `tests/setup.ts`**, which registers the jest-dom
  matchers. jsdom is the environment; anything that needs a real canvas or real
  tiles is out of scope for unit tests.
- **Name the behaviour, not the function.** `it('rejects a row whose borough is
  not one of the five NYC boroughs')` beats `it('testBorough')`.

## Data-change etiquette

Changing the pipeline changes the published dataset, so it deserves a higher bar
than a UI change.

1. **Inspect before and after.** Run `npm run data:inspect` on the raw snapshot
   before your change, and paste both outputs in the pull request. If your change
   is supposed to alter what is published, the diff should be visible in those
   numbers.
2. **Show the delta.** `git diff --stat -- public/data data/processed` and the
   `report.json` counters. A change that silently moves 40 records needs an
   explanation in the description, not in a comment.
3. **Never repair data silently.** The pipeline's contract is that anything it
   changes is counted in `report.pipeline` and anything it drops is listed in
   `report.rejections` with a reason. If your change fixes a value, count it. If
   it drops a row, name it.
4. **Keep rules derived from evidence.** The two validation rules exist because
   the dataset's own contents showed them to be necessary — six bad rows out of
   2 437, each reproducible. Do not add a rule because it seems sensible. If you
   do add one, cite the rows that motivated it.
5. **Update `SCHEMA` when the measurement moves.** `validate_data.py` hard-codes
   the 2026-09-27 measurements as drift baselines. When a legitimate upstream
   change moves them, update the numbers *and* say so in the pull request, so a
   reader knows the difference between "the pipeline changed" and "the world
   changed".
6. **One dataset per pipeline.** Do not make `clean_data.py` fetch, and do not
   fold a second source into the cafe artifact. The layering rules are in
   [`data-pipeline.md`](data-pipeline.md#adding-a-new-nyc-open-data-layer).
7. **Regenerate, never hand-patch.** If you changed `clean_data.py`, the
   committed artifacts must come from running it. CI runs
   `validate_data.py --strict` on the published files, and a hand-patched
   artifact set fails on the hash or the arithmetic.

## What not to add

This is a factual map of a government dataset. Several tempting features would
make it worse, and they are not welcome:

- **No ratings, reviews or scores.** The source has none. Any number on this site
  would be invented or scraped from somewhere that does not grant permission for
  it.
- **No hours of operation.** The source has none, and a roadway café's real
  hours depend on the season. See the April 1 – November 29 window in the
  README.
- **No menus, prices, price ranges, cuisines, photos or reservation links.** Same
  reason. Nothing here stands in for data we do not have.
- **No recommendations, "best of" lists, or ranking.** The app does not tell you
  where to eat. It tells you where licences exist.
- **No AI features.** No generated summaries, no natural-language search over
  descriptions, no embeddings. Every field on screen came from a named column in
  a named public dataset, and that is the project's core promise.
- **No accounts, no sign-in, no cookies, no analytics, no tracking of any kind.**
  This is why there is no backend. A pull request that introduces user identity
  is a pull request for a different project.
- **No proprietary or gated data source.** No Mapbox token, no Google, no
  scraped Yelp or Google Places data, no paid geocoder. The basemap is
  key-free and the data is public. Keep it that way, or the project is no longer
  forkable by a stranger in one click.
- **No vendored basemap style JSON.** It is the thing that makes MapLibre drop
  the OpenStreetMap attribution. Point `VITE_BASEMAP_STYLE_URL` somewhere
  instead.

If you want to build one of those, build it as your own project on top of the
published GeoJSON. The artifact is a plain static file precisely so that is
possible.

## Decisions

Some of the rules above exist because of a decision, and the decision is
recorded separately in [`docs/adr/`](adr/) with the alternatives that were
rejected and, where there was one, the measurement that rejected them. The
index — read it before you change anything — is
[`decisions.md`](decisions.md).

| Decision | Why the rule above exists |
| --- | --- |
| [0001 — Freeze the location schema](adr/0001-freeze-the-location-schema.md) | The frozen contract, and why the schema is written down twice on purpose |
| [0002 — Hash the features, never the timestamp](adr/0002-hash-features-never-the-timestamp.md) | Why `content_hash()` is not to be touched, and why `git diff` is not the change detector |
| [0003 — A keyless basemap and three runtime dependencies](adr/0003-keyless-basemap-three-runtime-deps.md) | OpenFreeMap, the three dependencies, the standard-library pipeline, and the whole "what not to add" list |
| [0004 — Record decisions as ADRs](adr/0004-record-decisions-as-adrs.md) | Why this section exists |
| [0005 — Hand directions to Google Maps over a web URL](adr/0005-google-maps-directions-handoff.md) | Why the app may link out to Google Maps without a key, and what "no Google" in the list above is actually forbidding |

**Write an ADR before you write the code** if your change adds a runtime or
pipeline dependency, alters the contract, touches `content_hash()` or the id
recipe, adds a second feature kind or a second data layer, changes the basemap
or the geocoder, or relaxes anything in "What not to add". The trigger list and
the template are in [`decisions.md`](decisions.md).

Everything else is an issue or an ordinary pull request. A decision record that
includes every bug fix is one nobody reads.

## Pull request process

1. **Open an issue first** for anything larger than a bug fix. The
   [issue templates](../.github/ISSUE_TEMPLATE/) are there for a reason, and a
   fifteen-minute conversation before you write the code is cheaper than a
   rejected pull request.
2. **Branch from `main`**, one topic per branch.
3. **Run `npm run verify` and `npm run test:data`** before you push.
4. **Fill in the pull request template.** The frozen-contract checklist is the
   part that matters; tick it honestly rather than optimistically.
5. **CI must be green.** `ci.yml` runs two independent jobs: lint, typecheck,
   test and build, and the data validation plus the Python tests. Both on every
   pull request.
6. **Expect discussion on data changes.** A pull request that changes which rows
   are published needs a maintainer to read the before/after numbers, not just
   the diff.

**Merging.** Maintainers merge with a squash or a rebase. The bot pushes data
commits directly to `main` with
`data: refresh fpeh-f7ci (N locations, hash abc1234)`; those never conflict with
your work in practice, and the refresh workflow rebases once if they ever do.

**Deploying your fork.** Push to `main` on your own repository with Pages set to
build from GitHub Actions. `deploy.yml` derives `VITE_BASE_PATH` from the
repository name, so no file needs editing. See the README.

## Commit messages

Conventional Commits, lowercase scope, short subject:

```
feat: add borough filter to the sidebar
fix: treat a missing nta as null instead of an empty string
docs: explain why postcode is not a validation gate
test: cover the ambiguous_license_group rejection
data: refresh fpeh-f7ci (2000 locations, hash b5c4740)
refactor: extract the bbox check from merge_groups
```

The `data:` prefix is reserved for the refresh bot. Do not use it by hand; a
human commit under that prefix makes the no-op commit history harder to read.

## Reporting a problem instead of fixing it

If the bug is in the data rather than in the code, file it rather than patching
`cafes.geojson`. The
[data report template](../.github/ISSUE_TEMPLATE/data_report.yml) asks for the
name, the street, and what you saw, which is exactly what is needed to check it
against the source.

The most common reports will be one of:

- **This location is not on the map.** Often a rejected row — the six known bad
  records are listed in `report.json` — or a licence issued after the last
  refresh.
- **The address is wrong.** The coordinates come from DOT's geocoder, not from
  us. The pipeline does not second-guess a coordinate that falls inside the
  bounding box, because it has no way to know which of the two is wrong.
- **It says roadway but the café is shut.** Expected between December and March.
  Roadway licences run April 1 – November 29.
- **The name looks odd.** We publish the source's UPPERCASE text verbatim,
  including the legal entity name as secondary text.
