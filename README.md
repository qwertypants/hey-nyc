# Eat Outside NYC

A map of every New York City food establishment that holds a Dining Out NYC licence for sidewalk or roadway dining, plus a second, quieter map of where the city counts people walking. No account, no backend, no tracking — a static map and a few GeoJSON files, rebuilt from NYC Open Data every morning.

<p align="center">
  <img src="docs/screenshot.png" alt="An illustrated aerial view of New York City, with Manhattan between the Hudson and East rivers and the Brooklyn and Queens bridges to the right, dotted with coloured map pins marking Dining Out NYC licence locations." width="900" />
</p>

<p align="center">
  <a href="https://qwertypants.github.io/hey-nyc/"><strong>Open the live map →</strong></a>
</p>

**Live site:** <https://qwertypants.github.io/hey-nyc/> — static, no install, no
account, no tracking.

<!-- The Pages URL for a project site is always
     https://<owner>.github.io/<repo>/, and .github/workflows/deploy.yml
     derives the matching VITE_BASE_PATH from the repository name at build
     time. So a fork needs only the three hand-written Pages URLs changed —
     the "Open the live map" link above, the "Live site" line, and the URL in
     "Deployment" — and nothing else. Note the repository is `hey-nyc` while
     the app is called Eat Outside NYC — see "Deployment" for what that means
     for a fork. -->

## Contents

- [What this is not](#what-this-is-not)
- [Project purpose](#project-purpose)
- [Data sources](#data-sources)
- [Where NYC Walks](#where-nyc-walks)
- [Storefront Pulse](#storefront-pulse)
- [Architecture](#architecture)
- [Local development](#local-development)
- [Data refresh](#data-refresh)
- [Deployment](#deployment)
- [Attribution](#attribution)
- [Contributing](#contributing)
- [Limitations](#limitations)
- [License](#license)

## What this is not

Read this before you use the app or judge the dataset.

- **Not a restaurant recommendation.** Nothing here ranks, scores, suggests or
  compares. A marker means a licence exists. Whether the food is any good is not
  modelled, not stored, and not knowable from this dataset.
- **Not a live availability check.** There is no "seats free right now" signal
  and there cannot be one from this data.
- **Not an account system.** No sign-up, no login, no cookies, no analytics, no
  server. There is nothing to sign in to and nothing tracking you.
- **Not AI-generated.** No recommendations, no summaries, no inference. Every
  field on screen came from a single public government dataset.
- **Not a walking app.** Where NYC Walks does not route, does not recommend a
  route, does not tell you where to walk, and does not draw a path between
  anything. It shows counts at the places the city counts, and refuses to guess
  at the streets in between.
- **Not a substitute for the city's own record.** If you need to know whether a
  specific licence is currently valid, ask NYC DOT directly.

## Project purpose

New York City's Dining Out NYC programme let restaurants and bars set up
outdoor dining on the sidewalk and, seasonally, in the roadway. DOT publishes the
list of participating establishments as open data. It is genuinely useful and
genuinely hard to read: it is a table, not a map.

Eat Outside NYC does one thing with it: it puts every one of those establishments
on a map, colour-coded by licence type, searchable by name, street, neighbourhood
or borough, and honest about what the data does and does not say.

The current published snapshot contains **2 000 establishments** across all five
boroughs — 1 173 sidewalk, 396 roadway, and 431 that hold both.

The same provider, the same licence-free endpoints and the same constraints
produce the second feature, [Where NYC Walks](#where-nyc-walks) — 114 hand-counted
pedestrian screenline sites and 4 automated counters. It is a separate question
about the same city, built from separate datasets and never combined with the
first one numerically.

Design constraints, all deliberate:

- **Map-first.** The map is the application, not a widget inside a page.
- **Static.** No server, no database, no API of our own. The build output is
  files.
- **No accounts.** Nothing to sign in to means nothing to leak, and no user data
  to protect.
- **Factual only.** Every field is traceable to a named column in a named public
  dataset. Nothing is inferred, enriched, guessed or filled in.
- **Forkable.** One `npm ci` and one `npm run dev`. No API keys, no accounts
  with any third party, no secrets.

## Data sources

Two features, four NYC Open Data datasets, one provider: the **New York City
Department of Transportation (NYC DOT)**. All are read through the Socrata v2.1
JSON endpoint: no API key, no registration.

| Feature | Dataset | Rows | What a row is |
| --- | --- | --- | --- |
| Eat Outside NYC | [`fpeh-f7ci`](https://data.cityofnewyork.us/Transportation/Dining-Out-NYC-Locations/fpeh-f7ci) | 2 437 | one licence |
| Where NYC Walks | [`cqsj-cfgu`](https://data.cityofnewyork.us/Transportation/Bi-Annual-Pedestrian-Counts/cqsj-cfgu) | 114 | one manual screenline count site |
| Where NYC Walks | [`ct66-47at`](https://data.cityofnewyork.us/Transportation/Bicycle-and-Pedestrian-Counts/ct66-47at) | 21 269 650 | one automated 15-minute count |
| Where NYC Walks | [`6up2-gnw8`](https://data.cityofnewyork.us/Transportation/Bicycle-and-Pedestrian-Count-Sensors/6up2-gnw8) | 67 | one sensor |

### Dining Out NYC Locations (`fpeh-f7ci`)

- The city's own row label is a "food service establishment that is participating
  in the Dining Out NYC program".
- Published by automated job, daily.
- Read through the Socrata v2.1 JSON endpoint. No API key, no registration.
- The full column-by-column breakdown, including the 9 of the 23 source columns
  we do not use and the six rows we reject, is in
  [`docs/data-dictionary.md`](docs/data-dictionary.md).

The source publishes **one row per licence**, not one row per business. A
business with both a sidewalk and a roadway licence appears twice. The pipeline
merges those pairs into a single `both` entry; that is where the 2 437 source
rows become 2 000 establishments.

### The pedestrian counts (`cqsj-cfgu`, `ct66-47at`, `6up2-gnw8`)

Same provider, same licence-free endpoints, and a much smaller story: DOT's
bi-annual screenline program covers **114 locations**, and its automated
pedestrian counters cover **four physical counters**, two of which have not
reported in over three months. The methodology, every threshold and the blunt
list of what the data cannot say are in
[`docs/where-nyc-walks.md`](docs/where-nyc-walks.md); the measurements behind
them, with the queries, are in
[`docs/walk-data-analysis.md`](docs/walk-data-analysis.md), and the decision to
lead with the screenline program is
[ADR 0006](docs/adr/0006-lead-with-the-bi-annual-counts-not-the-live-feed.md).

## Storefront Pulse

Storefront Pulse maps DOF's December-reported vacant storefront records and
summarizes vacant, reported non-vacant and unknown status by neighborhood. It
defaults to the literal 2024 reporting label; changing periods loads that cohort
on demand. The 414,884 source reports remain separate reports, including repeated
rows. Counts do not establish distinct premises, current businesses or availability.

Construction is reported true, false or unknown. Non-vacant records are aggregate
counts; the source's NO includes owner-occupied and leased space. The incomplete
2025 cohort has no explicit non-vacant population, so vacancy share is unavailable.
Older 2010 neighborhood codes retain their summaries and coordinate-derived label
anchors, but the retired official boundary endpoint means no polygons for those
areas. History and business-category normalization remain deferred.

See [the methodology and refresh commands](docs/storefronts.md),
[source research](docs/storefront-data-analysis.md) and
[ADR 0010](docs/adr/0010-load-storefront-reports-by-period.md).

## Where NYC Walks

Eat Outside NYC answers "where can I sit outside". This answers a much smaller
question: **where does the city actually count people walking, and what did it
measure there.**

DOT runs two unrelated pedestrian counting programs and this project publishes
both, side by side, without ever combining their numbers:

| | Bi-annual screenline counts | Automated counters |
| --- | --- | --- |
| Locations | **114** | **4** |
| Measurement | a manual two-hour count, morning / midday / evening | a 15-minute automated count, folded in + out |
| Cadence | 2–3 discrete surveys a year | a daily batch, hours behind |
| Span | 2007 → 2026 | 2022 → 2026 |
| Published as | `historical-locations.geojson`, `historical-patterns.json` | `sensors.geojson`, `latest.json` |

A screenline site publishes its latest survey and its direction of travel since
the first one — 41 rising, 41 falling, 32 flat, none unclassifiable. A counter
publishes where its most recent reading sits **in its own recent history at the
same weekday and time of day**: `quiet`, `typical`, `busy` or `veryBusy`, plus a
freshness state. Four of the five freshness states are derived from the age of
that reading; the fifth, `faulted`, is not — it means the counter is reporting on
schedule and every reading is zero, which a dead counter does while looking
fresher than any working one. See
[ADR 0007](docs/adr/0007-fault-a-counter-publishing-zeroes-is-not-fresh.md).

Three things it deliberately does not do:

- **It does not tell you where to walk.** Four counters is four points.
- **It does not interpolate.** The nearest counter to any screenline site is
  624 m away and not one pair is co-located. No heat surface, no gradient
  between dots, no isochrone — those would be pictures of the interpolation.
- **It does not compare boroughs.** Two counters in the Bronx, one in Brooklyn,
  one in Manhattan, none in Queens or Staten Island, and DOT's `borough` column
  in the historical dataset is not a borough column at all (19 of its 114 sites
  carry a waterway name, and 5 carry a truncated `Staten Isla` — published
  verbatim, warned about, never repaired).

Both programs are in the same app because they are the same city's pedestrian
data, not because they are commensurable. A `busy` screenline and a `busy`
counter are two different words.

## Architecture

```
data/raw/fpeh-f7ci.json          byte-for-byte copy of the Socrata response
        |  scripts/clean_data.py       validate -> merge -> emit
        v
public/data/cafes.geojson        2 000 Point features, ~936 KB (~182 KB gzipped)
public/data/metadata.json        provenance, counts, contentHash
data/processed/report.json       rejections, merge anomalies, counters
        |
        |  static fetch at runtime, no build step in between
        v
MapLibre GL + React              the whole application
```

Three decisions carry the design.

**1. Static GeoJSON, fetched at runtime.** `cafes.geojson` is a file in the build
output, fetched by the browser and handed to MapLibre as a GeoJSON source. It is
not bundled into the JavaScript, and it is not pre-tiled. The consequences:

- Gzip does the heavy lifting. ~936 KB on the wire becomes ~182 KB, which is
  well inside what a phone will pull down without complaint.
- A data refresh is a data commit, not a rebuild of anything clever. The daily
  workflow pushes three JSON files.
- There is no database to operate, scale, back up, or go down.
- The cost is honest: 2 000 points render in a single MapLibre source without
  any clustering, because clustering 2 000 points buys nothing. If the dataset
  ever grew by an order of magnitude this decision would need revisiting, and
  the change would be local to `src/map/`.

**2. No backend of any kind.** Not a proxy, not a cache, not an API. The only
network calls the running app makes are the static file fetch for its own data
and vector tile requests to the basemap. This is what makes "no accounts" and
"no tracking" true by construction rather than by policy.

**3. The frozen contract.** `src/types/location.ts` is the schema. The Python
pipeline writes it, `scripts/validate_data.py` asserts the published artifacts
against it, and the TypeScript loader validates at runtime. Neither side can
drift without CI failing. The walk artifacts have their own, identical contract
— `src/types/walk.ts` against `scripts/walk/validate_walk.py` — and the same
rule applies to both: change a field name, type, allowed value, property order
or id recipe on both sides in the same pull request. See
[`docs/contributing.md`](docs/contributing.md) for the rules that keep it frozen.

**4. Monochrome chrome, and a measured palette.** The interface is black on
white, in Uber's design language: full-pill controls, an 8px grid,
whisper-soft shadows, no gradients. This is a functional choice, not a
preference. The basemap underneath is a colourful raster and the dining type is
encoded in three hues, so a coloured chrome would be a fourth competing signal
fighting both — and black on white is also 21:1, the top of the contrast scale,
against a 4.5:1 floor. The only colour in the interface is the data.

That last part is enforced rather than asserted. `src/lib/contrast.ts` is the
WCAG 2.2 maths and `tests/contrast.test.ts` reads the real tokens out of
`src/index.css` and the real data colours out of `src/map/style.ts`, then holds
every text pair to 4.5:1, every meaningful boundary to 3:1, and the primary pair
to AAA — in the light scheme, the dark scheme, and both again under
`prefers-contrast: more`. Change a hex value to something prettier and CI tells
you the ratio you actually achieved, against the threshold it had to clear.

Two consequences worth knowing before you touch the CSS:

- **The focus indicator is two rings, not one colour.** The app is half black
  and half white, so a single focus colour cannot serve it: the blue this
  started with scored 6.70:1 on white and 2.56:1 on the black header, which is
  effectively invisible. The replacement is an inner paper ring plus an outer
  ink ring, and the test asserts that one of the two clears 3:1 on every
  surface the app paints.
- **The swatch edge flips with the colour scheme; the swatch fill does not.** A
  legend that disagrees with the map is a worse failure than a dim swatch, and
  the type is always named in words beside every swatch anyway.

`src/index.css` is the single stylesheet and its header documents the
accessibility contract it implements.

### Accessibility

The app targets **WCAG 2.2 Level AA**, which is the technical bar behind the
ADA obligations a site like this carries in the United States. Conformance is a
property of the whole thing, so it is spread across the code rather than bolted
on.

Three suites enforce it, and they are kept separate on purpose because they catch different
classes of defect. Contrast maths will never notice a button with no name; axe will never
notice a focus ring that is 2.56:1 against the header it sits on.

| Suite | What it holds | Why it cannot be merged into another |
| --- | --- | --- |
| `tests/contrast.test.ts` | Every colour pair against its WCAG threshold, in four schemes. Reads the tokens, not copies of them. | Needs the maths, not the DOM. |
| `tests/axe.test.tsx` | WAI-ARIA rules, accessible names, heading order, landmarks — in ten UI states. | Needs a rendered tree. |
| `tests/layout.test.ts` | Target size (2.5.8), text spacing (1.4.12), reflow (1.4.10), and the user-preference overrides. | Needs the declarations; jsdom has no layout engine to measure. |

Both stylesheet suites read `src/index.css` through one shared reader,
`tests/helpers/stylesheet.ts`, so they cannot drift into disagreeing about what the CSS says.

The rest is spread across the code rather than bolted on:

| Area | Where |
| --- | --- |
| Focus management, trapping, restoration | `src/hooks/useFocusTrap.ts` |
| Focus-not-obscured (2.4.11) | `src/index.css`, via `scroll-margin` on rows |
| Screen-reader semantics for the map's alternative | `src/components/LocationList.tsx` |
| Status announcements (4.1.3) | `src/App.tsx`, `src/components/SearchBox.tsx` |
| Keyboard model for the search combobox | `src/components/SearchBox.tsx` |
| Keyboard model for the view radiogroup | `src/components/LocationList.tsx` |
| Reduced motion, forced colours, enhanced contrast | `src/index.css` |

### The limit worth stating

`tests/layout.test.ts` reads declarations, not rendered boxes, because jsdom has no layout
engine. So it can prove *this control was given at least 24px of min-height* but not *the text
fits inside it*. A real browser audit — axe-core via Playwright, say — is the missing piece, and
it is the one thing this setup cannot substitute for. Until it exists, treat the layout
assertions as "the declaration is safe", which is the part under the author's control.

## Local development

**Prerequisites**

| Tool | Version | Notes |
| --- | --- | --- |
| Node.js | >= 20.19 | The `engines` field in `package.json` is the source of truth. |
| Python | 3.11+ | 3.12 is what CI uses. Only for the data pipeline. |
| npm | ships with Node | |

No Python dependencies are needed to run the app — only to rebuild the data.
The pipeline itself is standard library only.

**Install**

```bash
npm install
python3 -m pip install -r requirements.txt
```

**Get the data**

The repository ships the published artifacts in `public/data/`, so you can skip
this for UI work. Rebuild them from the live source when you touch the pipeline:

```bash
npm run data:refresh     # fetch -> inspect -> clean -> validate
```

**Run it**

```bash
npm run dev              # Vite dev server
```

The basemap is OpenFreeMap's `positron` style by default and needs no key. The
app caps at zoom 16; see [`docs/basemap.md`](docs/basemap.md) for why, and for
how to point it somewhere else.

**Everything else**

| Command | What it does |
| --- | --- |
| `npm run lint` | ESLint over `src`, `tests` and the config files. |
| `npm run typecheck` | `tsc --noEmit`. |
| `npm test` | Vitest: 940 tests over the loader, filters, search, URL state, colour contrast, layout resilience, axe, and the Where NYC Walks feature. |
| `npm run test:a11y` | The three accessibility suites on their own: contrast, layout, axe. |
| `npm run test:data` | `pytest tests/python` — 451 tests, no network. |
| `npm run build` | Typecheck, then a production build into `dist/`. |
| `npm run preview` | Serve the production build locally. |
| `npm run verify` | lint + test + build + strict Eat and Storefront artifact validation + pytest, in that order. This is `ci.yml`. |
| `npm run data:*` | `fetch`, `inspect`, `clean`, `validate`, `refresh`. |

The full runbook is in [`docs/data-pipeline.md`](docs/data-pipeline.md).

## Data refresh

**Automatic.** The `refresh-data` workflow runs daily at 10:23 UTC (06:23 in
New York). It fetches, rebuilds, validates, and then asks one question: did the
*records* change?

- **Yes** — it runs the full gate suite (lint, tests, data validation, build) and
  pushes a commit, which triggers a deploy.
- **No** — it commits nothing. A daily no-op costs one Python job and no npm
  install. The check compares a sha256 `contentHash` over the cleaned records,
  not a file diff, precisely so that the `retrievedAt` and `generatedAt`
  timestamps that change on every run do not produce a commit every morning.

You can also trigger it by hand from the Actions tab.

**The walk artifacts have their own workflow**, `refresh-walk-data`, and their
own reasons:

- It runs **once a day, not every six hours**, because the pedestrian count feed
  is a daily batch with a multi-hour ingestion lag — it was 7.6 hours behind on
  `rowsUpdatedAt` and 14.6 hours behind on the newest pedestrian row when it was
  measured. A six-hourly schedule would re-fetch identical data three times out
  of four.
- It caches the raw snapshot between runs, keyed on the pipeline code, so the
  56-day baseline window is fetched incrementally instead of from scratch — and
  so a change to the derivation invalidates the cache rather than reusing it.
- It asks the same question `refresh-data` asks — did the published records
  change? — using the same `contentHash` comparison, per
  [ADR 0002](docs/adr/0002-hash-features-never-the-timestamp.md). Unlike the
  dining artifacts, its counter hash legitimately moves most days, because
  freshness is a published property and a counter ageing from `fresh` to
  `offline` is a real change.
- It commits only. `deploy.yml` remains the only thing that publishes.

**Manual**

```bash
npm run data:refresh                 # full pipeline from the live source
npm run data:fetch                   # just download the raw snapshot
npm run data:inspect                 # profile the raw snapshot, no writes
npm run data:clean                   # raw snapshot -> public/data
npm run data:validate -- --strict    # assert artifacts vs the contract

python3 scripts/walk/refresh.py      # the walk pipeline, both fetches then build
python3 scripts/walk/refresh.py --offline   # rebuild from the raw snapshot, no network
python3 scripts/walk/history/fetch.py       # just the 114-row screenline snapshot
```

If you rebuild the data, commit `public/data/cafes.geojson`,
`public/data/metadata.json` and `data/processed/report.json` together. The raw
snapshot under `data/raw/` is git-ignored on purpose; it is reproducible with
`npm run data:fetch`.

The walk artifacts follow the same rule and the same generated-file status:
commit everything under `public/data/walk/` and
`data/processed/walk/report.json` together, and never hand-edit any of them.
`src/types/walk.ts` is a frozen contract in the same sense as
`src/types/location.ts` — see
[`docs/contributing.md`](docs/contributing.md#the-frozen-contract).

## Deployment

GitHub Pages, from `main`, via `deploy.yml`. The site is at
**<https://qwertypants.github.io/hey-nyc/>**. It builds and publishes on a push to
`main`, and also fires when `refresh-data` succeeds — a commit pushed by the bot
does not trigger a `push` event, so the `workflow_run` trigger is what publishes
data-only changes.

The workflow runs `lint`, `npm test` and `build` before it uploads anything, so a
contrast ratio that drifts out of WCAG range or an axe violation introduced in the
same push fails the build and never reaches the site.

To deploy a fork:

1. Create the repository on GitHub.
2. Settings -> Pages -> Build and deployment -> Source: **GitHub Actions**.
3. Push to `main`.

That is the whole setup. There are no secrets to configure. The workflow derives
`VITE_BASE_PATH` from the repository name at run time, so a fork named
`eat-outside-nyc-fork` deploys correctly at
`https://<you>.github.io/eat-outside-nyc-fork/` without anybody editing a file.

**The repository is `hey-nyc`; the app is called Eat Outside NYC.** That mismatch
is real and deliberate-looking but undocumented in the source, so: the deployed
`<title>`, the `og:title` and the on-page wordmark all say *Eat Outside NYC* while
the URL says `hey-nyc`. Nothing breaks — `VITE_BASE_PATH` is derived from the
repository name at build time, so the subpath is always right — but if the
repository is ever renamed, `base` changes with it and the asset URLs follow
automatically. Only the three links in this README are hand-written.

If you serve the build from a different subpath yourself, set `VITE_BASE_PATH`
before building:

```bash
VITE_BASE_PATH=/some/path/ npm run build
```

It defaults to `./`, which is right for local development and for opening
`dist/index.html` straight off disk.

### One thing you should change before going live

Place search uses the public [Nominatim](https://operations.osmfoundation.org/policies/nominatim/)
endpoint, whose usage policy requires a working identifying contact. Out of the box
the app sends a placeholder (`eat-outside-nyc@users.noreply.github.com`) so a fork
works immediately — but a real deployment should identify itself:

```bash
VITE_GEOCODER_CONTACT=you@example.com npm run build
```

Set it as a repository variable so the workflow picks it up. The other
environment variable worth knowing is `VITE_BASEMAP_STYLE_URL`, the single seam for
swapping the basemap (see [docs/basemap.md](docs/basemap.md)).

The app is otherwise deliberately plain: no analytics, no cookies, no accounts, and
no request that leaves the visitor's browser carries their location.

## Attribution

Two separate obligations, from two separate sources. Both are honoured by the
running app, not just by this file.

**Data.** Every screen showing the map carries:

> Data from **NYC Open Data** — "Dining Out NYC Locations" (`fpeh-f7ci`),
> provided by the **NYC Department of Transportation**.

This is a requirement of the source, and it is enforced at runtime:
`metadata.json` carries the attribution string and the app renders it.

The walk layers carry their own, and they are the same obligation from the same
provider:

> Data from **NYC Open Data** — "Bi-Annual Pedestrian Counts" (`cqsj-cfgu`),
> "Bicycle and Pedestrian Counts" (`ct66-47at`) and "Bicycle and Pedestrian
> Count Sensors" (`6up2-gnw8`), provided by the **NYC Department of
> Transportation**.

`historical-patterns.json` and `latest.json` carry those strings in the artifact
itself, so the credit travels with the file rather than with the code.

**Basemap.** The map style is
[OpenFreeMap](https://openfreemap.org)'s `positron`, built on
[OpenMapTiles](https://www.openmaptiles.org/) from
[OpenStreetMap](https://www.openstreetmap.org/copyright) data (ODbL). MapLibre
reads the attribution from the style's TileJSON, so it appears automatically.
**Do not inline a copy of the style JSON into this repository** — that is
precisely what would break the attribution.

See [`docs/basemap.md`](docs/basemap.md) for the reasoning and for how to
self-host.

## Contributing

Read [`docs/contributing.md`](docs/contributing.md) first. The short version:

- `src/types/location.ts` and `scripts/` are a **frozen contract**. They change
  together, or not at all.
- Every behavioural change needs a test. There are 511 TypeScript tests and 213
  Python tests; match them.
- Do not add ratings, hours, menus, prices, cuisine or photos. They are not in
  the source dataset, and inferring them turns a factual map into a guess.
- Do not add a proprietary or scraped data source. This project is MIT and
  key-free on purpose.
- Never combine the two pedestrian programs. The 114 screenline sites and the 4
  automated counters are different measurements in different units with no
  co-located pair; a number that adds one to the other does not exist.
- Never repair the source's odd values — the truncated `Staten Isla`, the
  waterway names in `borough`, the three spellings of a survey column. They are
  published verbatim and counted in the report, because a repair would need a
  table the city never published. See
  [`docs/where-nyc-walks.md`](docs/where-nyc-walks.md#the-bi-annual-survey-model).
- A pull request that changes the data pipeline needs a before/after
  `python3 scripts/inspect_data.py` in the description.
- The rules above exist because of recorded decisions. Read
  [`docs/decisions.md`](docs/decisions.md) — and add an ADR if your change is
  the kind that has one.

Issues: use the templates in `.github/ISSUE_TEMPLATE/`. A data report about a
specific location is the single most useful thing a user can file.

## Limitations

This is the section to read before you rely on anything here. The app is honest
about all of it; this README should be too.

### Where NYC Walks

Stated here because it is the second feature; the full version, with every
threshold and the reason for it, is
[`docs/where-nyc-walks.md`](docs/where-nyc-walks.md#limitations).

**It cannot say where to walk.** The automated counter program has ever measured
four locations and was producing data at one of them. There is no ranking, no
recommendation and no route — and the "no recommendations" rule in
[`docs/contributing.md`](docs/contributing.md#what-not-to-add) is a second,
independent reason.

**It cannot interpolate to unmeasured streets.** The nearest automated counter to
any screenline site is 624 m away and not one pair is co-located. There is no
heat surface, no gradient between dots and no "walkability" fill, because each of
those would be a picture of the interpolation rather than of the data.

**It cannot compare boroughs, and it cannot compare the four counters to each
other.** Two in the Bronx, one in Brooklyn, one in Manhattan, none in Queens or
Staten Island, and DOT's `borough` column in the historical dataset carries a
waterway name for 19 of its 114 sites and a truncated `Staten Isla` for 5 more.

**Its "live" layer is a daily batch, not a stream.** It was 14.6 hours behind the
newest pedestrian reading when last measured, two of its four counters have not
reported in over three months, and a third has been publishing rows of nothing
but zeros for 45 days. Freshness is derived from the age of the newest reading
and shown as such; the source's own `status` column is `raw` on all 1 505 220
pedestrian rows and carries no information at all.

**The screenline half is a survey, not a series.** Two or three discrete counts
a year, with gaps — no September 2019 survey, October 2020 only, and 2024
counted in June. Nothing between surveys is interpolated, and a null period is a
period that was never counted.

**The automated layer may be dropped.** If the feed does not recover, four
counters that mostly say "no recent reading" are worse than no layer, and
[ADR 0006](docs/adr/0006-lead-with-the-bi-annual-counts-not-the-live-feed.md)
records that as the expected outcome rather than a failure.

### Eat Outside NYC

**Presence in this dataset means a licence exists — nothing more.** An entry
here indicates participation in NYC's Dining Out NYC program according to the
source data. It is **not** a restaurant recommendation, **not** a review, **not**
a rating, **not** a guarantee that the establishment is open, and **not** a
guarantee that outdoor seating is available right now. Licences expire, businesses
close, and seating fills up. `license_status` is `"Issued"` for 100% of rows in
the current snapshot, so the field carries no signal and the app ships no status
filter; a one-value filter would be a lie.

**Roadway cafés have a season.** Per DOT, roadway cafés may operate from
**April 1 through November 29**. Sidewalk licences may be operated year-round. In
winter a roadway location may simply be shut, and nothing in this data tells you
which ones. The detail view states the window; the map does not hide it.

**The source has known bad rows, and we reject them rather than repair them.**
Six of the 2 437 source rows are rejected, and every one is named in
`data/processed/report.json` with a reason:

| Rejected | Why |
| --- | --- |
| `ENZO'S OF ARTHUR AVE`, 2 rows | Geocoded to 42.126, -70.848 — **Boston, Massachusetts**, while the source `borough` says `Bronx`. |
| `MADELINE'S` / `SERENECO`, 2 rows | **Jersey City, New Jersey**, postcode `07307`. Coordinates happen to fall inside the NYC bounding box, so only the borough check catches them. |
| `BAR TABAC`, 2 rows | **Amityville, Suffolk County**, postcode `11701`. The longitude `-73.414` is roughly 20 km **offshore in the Atlantic**, east of Coney Island — not merely "in Brooklyn". Internally contradictory either way. |

These are upstream geocoding and data-entry failures, not cleaning bugs. A
business outside the five boroughs is not part of this program.

Both rules are always evaluated; the report names the most meaningful one
(`unknown_borough` outranks `out_of_bounds`, because a null `borough` means the
record is not in the program at all) and `inspect_data.py` shows the raw
unfiltered count. See [docs/data-dictionary.md](docs/data-dictionary.md#6-validation-rules-and-what-they-reject).

**There are no ratings, hours, menus, prices, cuisines, photos, reservation
links or seating capacities** — because the source dataset has none of them.
Nothing on this site stands in for them. If you want to know whether a place is
good or what it costs, you have to go and look.

**The basemap stops at zoom 14.** OpenFreeMap's `positron` style reports
`maxzoom: 14`, so past that MapLibre overzooms and the street layer goes soft. On
a dining map people do zoom to 16–17 to find one specific café. The app caps at
16 and the style is low-contrast, which hides it as well as anything can, but the
limitation is real. See [`docs/basemap.md`](docs/basemap.md).

**The public basemap instance has no SLA.** OpenFreeMap is a community resource
funded by donations. A fork that needs a guarantee should self-host.

**Location ids are derived, not durable.** `id` is `eoy-` plus the first 12 hex
characters of `sha1("<business_legal_name>|<street>")`. If DOT corrects a
business name or an address, that establishment's `id` **changes**. These are
deterministic and order-independent — which is what makes the daily no-op commit
detection work — but they are not permanent database keys, and anything that
saved an id across a correction will go stale.

**The data is a daily snapshot, not a live feed.** It is refreshed on a
schedule and it is correct as of the last refresh, which the app shows on screen.
It is never "now".

**`city` is not a city.** The source field called `city` holds a neighbourhood:
`NEW YORK`, `BROOKLYN`, `ASTORIA`, `FOREST HILLS`. The app publishes it as
`neighborhood` for exactly this reason.

**Some published fields are noise and are not repaired.** `bbl` values of `1` and
`3` are degenerate geocoder output and are normalised to `null`. Names keep the
source's UPPERCASE form because that is what the source publishes; the UI may
style it, the data does not pretend otherwise. Postcode is deliberately not a
validity gate — it is less reliable than `borough` and would reject good data.

## License

MIT — see [`LICENSE`](LICENSE).

The software is MIT. **The data is not.** The published dataset is derived from
NYC Open Data "Dining Out NYC Locations" (`fpeh-f7ci`) provided by the NYC
Department of Transportation and must be attributed as such. The basemap is
derived from OpenStreetMap data under the ODbL, served by OpenFreeMap and
OpenMapTiles. See [`docs/data-licensing.md`](docs/data-licensing.md).
