# Data pipeline runbook

Everything about how `data/raw/fpeh-f7ci.json` becomes
`public/data/cafes.geojson`, why it is built the way it is, and what to do when
it breaks.

For what each source column means and what the current numbers are, see
[`data-dictionary.md`](data-dictionary.md). For licensing, see
[`data-licensing.md`](data-licensing.md). This document is about operating the
pipeline.

## Contents

- [The shape of it](#the-shape-of-it)
- [Scripts and flags](#scripts-and-flags)
- [Validation rules](#validation-rules)
- [The Sidewalk + Roadway merge](#the-sidewalk--roadway-merge)
- [The stable id](#the-stable-id)
- [The contentHash and why it exists](#the-contenthash-and-why-it-exists)
- [Running it locally](#running-it-locally)
- [Automation](#automation)
- [Adding a new NYC Open Data layer](#adding-a-new-nyc-open-data-layer)
- [Troubleshooting](#troubleshooting)
- [Self-hosting the basemap](#self-hosting-the-basemap)

## The shape of it

```
NYC Open Data  fpeh-f7ci  (Socrata v2.1, no key)
        |
        |  fetch_data.py     one GET of the row endpoint + one of the view
        |                    metadata; writes the body through byte-for-byte
        v
data/raw/fpeh-f7ci.json          git-ignored, reproducible
data/raw/fetch-meta.json         git-ignored: row count, sha256, rowsUpdatedAt
        |
        |  inspect_data.py    profiles the snapshot, writes nothing
        v
        |  clean_data.py      normalise -> validate -> merge -> emit
        v
public/data/cafes.geojson        2 000 Point features
public/data/metadata.json        provenance + counts + contentHash
data/processed/report.json       rejections + anomalies + counters
        |
        |  validate_data.py   asserts all three against src/types/location.ts
        v
```

Three properties the design depends on:

1. **Standard library only.** `requirements.txt` has one entry, `pytest`, and
   it is test-only. Fetching is `urllib.request`, parsing is `json`, and that is
   all a Socrata v2.1 JSON endpoint needs. Adding pandas or requests would slow
   the Action and make the fork setup heavier for zero benefit.
2. **Byte-for-byte raw snapshot.** The HTTP response is written unchanged, and
   `fetch-meta.json` records its sha256. `clean_data.py` refuses to clean the
   canonical snapshot if the two disagree, so you can never accidentally clean a
   truncated download.
3. **Nothing is silently repaired.** A row that breaks a rule is rejected, and
   the rejection is written to `report.json` with a human-readable reason. A
   normalisation that changed something increments a counter in
   `report.pipeline`. There is no code path that quietly fixes data.

## Scripts and flags

Every script is importable and runnable. `sys.path` is arranged so
`tests/python` can `import clean_data` and the console entry point works from the
repository root.

### `fetch_data.py`

```
python3 scripts/fetch_data.py [-h]
```

No flags other than `-h`. Two requests:

1. `GET https://data.cityofnewyork.us/api/views/fpeh-f7ci.json` — the dataset
   metadata, which is where `name`, `attribution` and `rowsUpdatedAt` come from.
   The response's `id` is checked against the expected dataset id.
2. `GET https://data.cityofnewyork.us/resource/fpeh-f7ci.json?$limit=50000&$select=...`
   — every row.

The `$select` is built by `C.resource_select()`: `*,:id` plus any
`:@computed_region_*` columns named in the view metadata. `*,:id` alone is not
enough — Socrata drops the computed-region pseudo-columns, and the raw snapshot
is supposed to match the 23 columns the data dictionary documents. `sid` is the
only route back to the canonical source row, so `:id` has to be requested
explicitly.

Failure behaviour:

| Situation | What happens |
| --- | --- |
| HTTP 429, 5xx, timeout, connection error | Retried with bounded exponential backoff plus jitter. 4 attempts, capped at 30s. |
| HTTP 4xx other than 429 | **Not retried.** Fails immediately. |
| Body is not a JSON array | Fails. `PagedDataset` envelopes are rejected explicitly. |
| Zero rows | Fails rather than overwriting a good snapshot with nothing. |
| Any entry is not an object | Fails. |

### `inspect_data.py`

```
python3 scripts/inspect_data.py [--samples N]
```

Profiles the raw snapshot: row count, per-column presence and null counts,
distinct values for the low-cardinality enums, coordinate extent, and a sample of
rows. **Writes nothing.** Use it before and after touching `clean_data.py`, and
paste the output in a pull request that changes the pipeline.

### `clean_data.py`

```
python3 scripts/clean_data.py [--raw PATH] [--quiet]
```

`--raw PATH` reads a snapshot other than `data/raw/fpeh-f7ci.json`. Useful for
reproducing a bad fetch from a saved copy. Note that the sha256 verification of
the canonical snapshot only applies to `data/raw/fpeh-f7ci.json`; an explicit
`--raw` is a file the caller has taken responsibility for.

`--quiet` suppresses the summary; rejections and merge anomalies are still
printed, because those are the things you must not miss.

The stages inside: normalise each row, validate, group by `(legalName, street)`,
merge, emit, hash, write. Group iteration is over `sorted(groups)`, members are
sorted by `(sid, canonical_json(source))`, and features are sorted by `id` — so
the output is byte-identical regardless of the order Socrata returned rows in.

### `validate_data.py`

```
python3 scripts/validate_data.py [--strict] [--min-records N]
```

Asserts the three published artifacts against the contract in
`src/types/location.ts`. Two failure classes, deliberately kept apart.

**Corruption — always fatal.** Unparseable JSON, a non-Point geometry, a
coordinate outside the bounding box, a missing or duplicated `id`, `sid` not an
array of non-empty sorted strings, a source row published twice, and any
disagreement between the three files (record counts, per-type counts, borough
counts, the hash itself, the rejection arithmetic). The last group is what catches
a half-written artifact set: `report.sourceRows - rejected - duplicatesRemoved`
must equal the number of features, and `metadata.recordCount` and
`report.publishedLocations` must both equal the actual feature count.

**Drift — reported loudly, non-fatal by default.** A borough outside the five, a
`type` outside `sidewalk | roadway | both`, a `license_status` other than
`Issued`, an NTA or ZIP of the wrong length, a BBL outside 8–10 digits, an
unexpected property key, a source-row count different from the 2026-09-27
measurement, and any recorded merge anomaly.

`--strict` promotes every drift warning to a failure. **Use it in CI.** That is
the entire point of the flag: the app degrades gracefully when DOT publishes
something new, but a human should still look at it before it ships.

`--min-records N` defaults to 1500, a 25% guard band below the 2 000 measured on
2026-09-27. A refresh never moves that far in a day, so a breach means a
truncated or half-fetched snapshot, not real change.

### `refresh_data.py`

```
python3 scripts/refresh_data.py [--skip-fetch] [--quiet] [--strict]
```

Runs fetch -> inspect -> clean -> validate as one unit, stopping at the first
failure and exiting non-zero. It is safe as a CI or pre-commit step because
there is no partial state to recover: `clean_data.py` is the only writer, and it
only writes after every stage has succeeded.

`--skip-fetch` reuses `data/raw/` instead of re-downloading. `--strict` is
forwarded to the validate stage.

## Validation rules

Two independent row-level rules, both derived from the dataset's own
self-consistency rather than from guesswork.

### Rule 1 — coordinates must fall inside New York City

Bounding box: **lat 40.40 to 41.00, lng -74.30 to -73.65**. Padded well past the
observed extent (lat 40.574-40.910, lng -74.144 to -73.720 once the Boston
outlier is gone) so ordinary geocoder jitter is never mistaken for corruption.

The eastern limit of -73.65 is load-bearing. `BAR TABAC` is listed at
`128 SMITH STREET, AMITYVILLE 11701` with coordinates 40.6907, -73.4137 --
about 20 km **offshore in the Atlantic**, nowhere near a Suffolk County address.
On its own, that row fails this rule.

### Rule 2 - `borough` must be one of the five NYC boroughs

`Manhattan, Brooklyn, Queens, Bronx, Staten Island`, from the city's own
dictionary.

Rejects the two **Jersey City, New Jersey** establishments, whose `borough` is
null and whose postcode `07307` is a New Jersey ZIP. The Jersey City pair is the
interesting one -- its coordinates sit *inside* the NYC bounding box, so only the
borough check catches it.

`postcode` is deliberately **not** used as a validity gate. `borough` is the more
reliable field (one Manhattan row carries a `113` prefix, two Queens rows carry
`114`), so a postcode rule would reject good data.

### Why the report reads `outOfBounds: 2, unknownBorough: 4`

Both rules are evaluated on every row, and the **most meaningful** reason is the
one recorded, ranked `unknown_borough` above `out_of_bounds` -- a null `borough`
means the record is not in the program at all, which is truer than "its longitude
looked odd". The secondary failure is still named in the rejection text, and
`inspect_data.py` reports the raw unfiltered count (4 out of box), so the split is
never the only thing you can see.

Net effect: **2 437 rows -> 6 rejected -> 2 431 -> 2 000 establishments.**

`postcode` is deliberately **not** a gate. `borough` is more reliable: one
Manhattan record carries a `113` prefix and two Queens records carry `114`, so a
zipcode rule would reject good data.

### Rejection precedence

When a row breaks more than one rule, the code recorded is the first of:

```
missing_identity > missing_coordinates > unparseable_coordinates
  > unknown_borough > out_of_bounds > unknown_license_type
```

`unknown_borough` leads the coordinate rules on purpose: a null or non-NYC
borough means the row is not in the program at all, which is a more fundamental
finding than a bad geocode. Every rule a row breaks is still computed; only the
primary one is bucketed, and all of them appear in
`report.rejections[].reason`.

### Deliberately not repaired

| Case | Handling |
| --- | --- |
| `bbl` of `1` or `3` | Degenerate geocoder output. Normalised to `null`, counted in `pipeline.degenerateBbl`. |
| Missing `bin` / `bbl` / `nta2020` | Left missing. |
| UPPERCASE source names | Published verbatim. The source publishes them that way; the UI may style them, the data does not lie about them. |
| Whitespace runs | Collapsed. Counted in `pipeline.whitespaceCollapsed`. |
| `-`, `N/A`, `NULL`, `NONE`, `NaN` and friends | Treated as null. Counted in `pipeline.nullishText`. |

A 10-digit BBL is the real thing, but two live records legitimately geocode to 8
and 9 digits, so the floor is 8 rather than 10. Anything shorter than 5 digits is
junk.

## The Sidewalk + Roadway merge

`license_type` has exactly two source values, `Sidewalk` and `Roadway`. There is
no `Both` row, and the product needs a third state, so the pipeline derives one.

Rows are grouped by `(business_legal_name, street)`. Within a group:

| Group's `license_type` set | Published `type` |
| --- | --- |
| `{Sidewalk, Roadway}` | `both` |
| `{Sidewalk}` | `sidewalk` |
| `{Roadway}` | `roadway` |
| anything else, or more than two members | rejected as `ambiguous_license_group` |

Measured on 2026-09-27, this is unambiguous:

- 2 004 distinct `(legalName, street)` pairs across 2 437 rows.
- Group sizes are only ever 1 or 2. No group has three or more.
- All 433 two-row groups contain exactly one `Sidewalk` and one `Roadway`.
- All 433 two-row groups have **byte-identical** coordinates, not merely close.
- `business_legal_name + street + license_type` is unique across all 2 437 rows,
  which independently confirms the grouping key.

Within a group, the published value of each property is the first non-null in
`(sid, canonical_json(source))` order — deterministic, and independent of the
order the API returned rows in. `sid` collects every contributing row's `:id`,
sorted, so a `both` entry has two of them and nothing is lost.

**Merge anomalies are never silent.** If a group has more than two rows, two rows
of the same `license_type`, disagreeing coordinates, or disagreeing `bbl`, a
human-readable line is appended to `report.mergeAnomalies` and
`--strict` turns that into a failure. All 433 current groups are clean.

## The stable id

```
id = "eoy-" + sha1("<business_legal_name>|<street>").hexdigest()[:12]
```

Implemented once, in `_common.location_id()`. Chosen because it is:

- **deterministic** — same input, same id, on any machine, in any order;
- **independent of Socrata** — does not use `:id` or row order;
- **order-independent** — two refreshes that differ only in row order produce
  identical output, which is exactly what makes the no-op commit check work;
- **collision-free at this scale** — 2 000 ids, 0 collisions.

Rejected alternatives, with the measurement that killed each:

| Candidate | Distinct | Duplicated rows |
| --- | --- | --- |
| `bbl` | 1 840 | 597 |
| `bin` | 1 852 | 585 |
| `bbl` + `license_type` | 2 271 | 166 |
| `legalName` + `street` | 2 004 | 433 (the legitimate both-pairs) |
| `legalName` + `street` + `license_type` | 2 437 | 0 |

`bbl` identifies a *parcel*, so many unrelated businesses share one. It cannot be
a location key.

**The caveat is real and is documented in the README:** if DOT corrects a
business name or an address, that establishment's `id` changes. These are
deterministic hashes, not durable database keys, and the project does not pretend
otherwise.

## The contentHash and why it exists

```
contentHash = sha256( canonical_json( features sorted by id ) )
```

`_common.content_hash()`. `canonical_json` is `sort_keys=True`,
`separators=(",", ":")`, `ensure_ascii=False`. The features are the published
records; `metadata.json` and `report.json` are not inputs, so the hash
**structurally cannot observe a timestamp**.

The same digest is written into `public/data/metadata.json` and
`data/processed/report.json`, and `validate_data.py` recomputes it over
`cafes.geojson` and asserts both copies match.

It exists for one job: letting the daily workflow tell the difference between
"DOT published something new" and "we ran the pipeline again".

### Why not `git diff --quiet`

Because it does not work, and this is the single easiest thing to get wrong here.
`retrievedAt` (metadata.json) and `generatedAt` (report.json) are stamped with
"now" on every single run. Measured by running `refresh_data.py --skip-fetch`
twice, one minute apart:

| File | Result |
| --- | --- |
| `public/data/cafes.geojson` | byte-identical |
| `public/data/metadata.json` | differs — only `retrievedAt` |
| `data/processed/report.json` | differs — only `generatedAt` |
| `contentHash` | identical |

A naive diff therefore reports a change 365 days a year and commits 365 times a
year, each one a no-op that also invalidates the npm cache, re-runs the build and
triggers a deploy.

### What the workflow actually does

`.github/workflows/refresh-data.yml`, in the "Detect material change" step:

1. Recompute the hash over the `cafes.geojson` that is about to be committed and
   assert it matches `metadata.json` and `report.json`. A hand-edited
   `cafes.geojson` cannot slip past.
2. Read the baseline: `git show HEAD:public/data/metadata.json`, and recompute
   the baseline's own hash over `git show HEAD:public/data/cafes.geojson`. If the
   committed baseline does not agree with itself, fail — a corrupt baseline is
   not something to build a decision on.
3. Independently compare all three artifacts after treating `retrievedAt`,
   `generatedAt` and `sourceUpdatedAt` as non-material.
4. If the two signals agree the data changed, run the gates and commit. If they
   agree nothing changed, restore the artifacts and stop. If they **disagree**,
   fail the workflow without committing — disagreement means this repository is
   broken, not that upstream drifted.

`sourceUpdatedAt` is non-material on purpose. It is the dataset's
`rowsUpdatedAt`, which moves when DOT republishes metadata even if not one row
changed. Committing for that would add a commit every day forever.

When there is no baseline at all — a fresh repository, or one where
`metadata.json` is not yet tracked — the answer is "changed", because the first
snapshot has to be published.

To see the decision for yourself:

```bash
python3 scripts/refresh_data.py --skip-fetch
python3 -c "import json; print(json.load(open('public/data/metadata.json'))['contentHash'])"
git diff --stat -- public/data data/processed     # timestamps only
```

## Running it locally

```bash
python3 -m pip install -r requirements.txt

npm run data:refresh            # the whole thing, from the network
npm run data:refresh -- --skip-fetch   # reuse data/raw/
```

Useful during development:

```bash
npm run data:inspect            # profile the raw snapshot
npm run data:clean              # rebuild artifacts from data/raw/
npm run data:validate -- --strict
python3 -m pytest tests/python -q
```

Never hand-edit `public/data/cafes.geojson`, `public/data/metadata.json` or
`data/processed/report.json`. Change `clean_data.py`, rerun, and commit all
three together. `validate_data.py` will notice.

## Automation

`refresh-data.yml` runs daily at 10:23 UTC and on demand. The full reasoning is
in the workflow file, but the shape is:

- 10:23 UTC == 06:23 in New York. After the overnight NYC Open Data ETL window
  has finished, and at an off-peak minute for the shared Actions runner pool
  (`:23` rather than `:00`).
- `concurrency: refresh-data` with `cancel-in-progress: false`, so a manual run
  is never killed halfway through a push.
- `contents: write`, a full-history checkout, one rebase-and-retry on push, and
  never `--force`.
- Gates before the commit: `npm ci`, `npm run lint`, `npm test`,
  `npm run data:validate -- --strict`, `npm run build`. Any failure aborts the
  job, so a broken snapshot is never committed and therefore never deployed.
- Commit subject: `data: refresh fpeh-f7ci (2000 locations, hash abc1234)`.

`deploy.yml` picks the result up through its `workflow_run` trigger, because a
commit pushed with `GITHUB_TOKEN` does not fire the `push` event.

A scheduled workflow is disabled by GitHub after 60 days of repository
inactivity. If the site stops updating, check that first, then run
`refresh-data` manually from the Actions tab.

## Adding a new NYC Open Data layer

Phase 3 of the brief. A second layer — open streets, park boundaries, anything
else on NYC Open Data — is a **separate ingestion with its own contract**, not an
extension of the cafe logic. The rules below exist because the obvious shortcut
produces the thing this project is trying not to be.

**Do:**

1. **Independent ingestion.** A new `scripts/fetch_<layer>.py` and a new dataset
   id in `_common.py`. Do not add parameters to `fetch_data.py`, and do not make
   `clean_data.py` fetch anything. Each layer is a separate
   `data/raw/<dataset-id>.json` and a separate fetch metadata file.
2. **Independent validation.** A new `validate_<layer>.py` with its own rules,
   its own rejection reasons, and its own report. Its geometry rules come from
   that dataset's own dictionary, measured by inspecting it — never copied from
   the cafe rules, which are specific to fpeh-f7ci's bad rows.
3. **Its own GeoJSON.** A separate published artifact, for example
   `public/data/streets.geojson`, with its own metadata and its own contentHash.
   It gets a `metadata.<layer>.json` entry only if the UI needs counts.
4. **Its own map visibility toggle.** A layer is on or off by default, decided
   by whether it is useful to the user's task, and the default must be
   defensible. Do not enable a decorative layer by default just because it is
   free.
5. **Its own TypeScript contract.** Extend `src/types/location.ts` with new
   interfaces, or add a `src/types/<layer>.ts` and import both. Whatever you do,
   `validate_<layer>.py` asserts the new artifact against it and the runtime
   loader validates it, exactly as the cafe path does.
6. **Its own change detection.** Its own contentHash and its own comparison in
   the refresh workflow, or at minimum a hash that never observes a timestamp.
   Never widen an existing hash to cover a new layer; a layer that never changes
   would then make the whole commit gate look quiet forever.
7. **Documented provenance.** Dataset id, provider, licence, attribution string
   and retrieval URL in that layer's own metadata file, and a new section in
   `docs/data-dictionary.md` with the columns you use and the ones you rejected.
8. **Its own tests.** Python tests on inline fixtures with no network, and
   TypeScript tests at the loader boundary.

**Do not:**

- Couple the new layer to the cafe logic. No "if the row is a cafe, also look up
  X in the other dataset". Layers compose in the renderer, not in the pipeline.
- Add the new layer's source rows to `fpeh-f7ci.json`, or make
  `clean_data.py` emit a second feature kind into `cafes.geojson`. The name is
  the contract: it is a cafe file.
- Change the cafe `contentHash` definition. If you touch
  `_common.content_hash()`, the next refresh looks like a data change and
  commits for the wrong reason.
- Let a new layer change a `LocationProperties` field. That is a contract change
  and needs the full frozen-contract treatment.

## Troubleshooting

**`fetch_data.py failed` / `FetchError`**

Read the message; it names the URL and the status. `giving up after 4 attempts`
means four retries were exhausted — the city endpoint is down or rate-limiting.
The other non-transient message means it refused to retry, which is correct for
a 4xx. Check the dataset still exists at
`data.cityofnewyork.us/Transportation/Dining-Out-NYC-Locations/fpeh-f7ci`.

**`the endpoint returned zero rows; refusing to overwrite the snapshot`**

The API returned an empty array. Usually a transient Socrata fault. Retry. If it
persists, do not work around it — an empty snapshot that overwrites a good one
would publish an empty map.

**`does not match fetch-meta.json (sha256 ... != ...)`**

`data/raw/fpeh-f7ci.json` was edited, truncated, or partially written. The
pipeline is refusing to clean a snapshot it cannot vouch for. Fix it with
`npm run data:fetch`, not by editing the sha.

**`missing artifact: ... — run scripts/refresh_data.py`**

The published files are not in the working tree. On a fresh clone that is
expected: run `npm run data:refresh`, or `npm run data:refresh -- --skip-fetch`
if you have a snapshot.

**`record count collapse: N locations, expected at least 1500`**

The snapshot is truncated or half-fetched. A real refresh never moves 25% in a
day. Re-fetch. If a genuine mass removal is happening upstream, that is a
conversation with a human before it ships.

**`SCHEMA DRIFT: unknown license_status 'Expired' x N`**

DOT started publishing a second licence status. This is the field that has been
`Issued` for 100% of rows since the project began, so no status filter ships.
Decide deliberately whether a filter is now justified; do not let the warning
pass unnoticed and do not add the filter reflexively.

**`SCHEMA DRIFT: N merge anomalies recorded in report.json`**

Upstream stopped producing clean sidewalk/roadway pairs. Read
`report.mergeAnomalies` in full. The entries are self-describing:
`group_of_3_plus`, `repeated_license_type`, `coordinate_disagreement`,
`bbl_disagreement`, `ambiguous_license_group`.

**`report arithmetic: N source rows - R rejected - D duplicates != P published`**

An artifact set is internally inconsistent, which usually means someone edited
`report.json` by hand. Regenerate all three files with `npm run data:clean`.

**`contentHash ... does not match a recomputation over cafes.geojson`**

Either `cafes.geojson` was hand-edited, or the file and the hash came from
different runs. Never "fix" this by editing the hash. Rerun
`npm run data:clean` and commit all three artifacts together.

**The workflow commits every morning and nothing changed**

Change detection is broken. Check the "Detect material change" step in the run
summary — it prints both signals. If `hash_changed` and `content_changed` both
read true against identical data, the `contentHash` definition in
`_common.py` has changed, which changes every id-fed hash and must be treated as
a deliberate contract change.

**The workflow never commits and the site is stale**

Usually the GitHub 60-day inactivity rule has disabled the schedule. Run
`refresh-data` manually from the Actions tab and check
`Actions -> refresh-data` for a disabled-schedule notice.

**The build is fine locally but 404s on Pages**

`VITE_BASE_PATH` is wrong. It must be `/<repo>/` for a project site and `/` for an
owner site. `deploy.yml` derives it from `github.repository`; check the
"Resolve the Pages base path" step output.

## Self-hosting the basemap

The app uses OpenFreeMap's hosted `positron` style, which needs no key and has no
rate limit, but no SLA either. `docs/basemap.md` has the full comparison against
Mapbox, Protomaps and `demotiles.maplibre.org`, and the attribution obligations
that come with each.

To point at your own tiles, set one environment variable at build time. Nothing
else in the app assumes a particular basemap — the layer stack in
`src/map/layers.ts` only touches the GeoJSON source we control.

```bash
VITE_BASEMAP_STYLE_URL=https://tiles.example.org/styles/positron.json npm run build
```

In CI, add it to the `env:` of the build step in `deploy.yml`.

Two rules when self-hosting:

1. **Keep the attribution.** MapLibre reads `attribution` from the style's
   TileJSON. If you hand-write a style, you must supply OpenStreetMap and
   OpenMapTiles credits yourself.
2. **Do not inline the style JSON into this repository.** A vendored copy is how
   attribution silently disappears, and it is the one thing that would make this
   project non-compliant with the data it is built on.

If you need street-level crispness past zoom 14, that is the reason to do it:
publish a Protomaps PMTiles build or an OpenFreeMap planet extract, serve the
vector tiles yourself, and point `VITE_BASEMAP_STYLE_URL` at your style.
