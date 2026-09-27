# Pull request

## What this changes

<!-- One or two sentences. If it changes what gets published, say so here and
     link the before/after numbers. -->

## Type of change

- [ ] Bug fix in the app
- [ ] Bug fix in the data pipeline
- [ ] New user-facing feature
- [ ] Change to the published schema or the pipeline rules
- [ ] Documentation only
- [ ] Build, CI or deployment

## Checklist

- [ ] `npm run verify` passes locally (lint, tests, build, data validation)
- [ ] `npm run test:data` passes locally
- [ ] I added tests for the behaviour I changed, and they fail without it

### Frozen contract

The schema in `src/types/location.ts` and the Python pipeline are two
implementations of one contract. If you touched the schema, the id recipe, the
property order, the allowed values, or `content_hash()`, say so explicitly:

- [ ] Not applicable, or: I changed the contract and updated **both** sides in
      this pull request

Files touched on each side:

<!--
src/types/location.ts:
scripts/_common.py (PROPERTY_ORDER, PROPERTY_TYPES, ID_RE):
scripts/clean_data.py:
scripts/validate_data.py (SCHEMA, check_geojson):
docs/data-dictionary.md:
tests/data-load.test.ts:
tests/python/test_geojson.py:
-->

### If this changes the data

- [ ] I did not hand-edit `public/data/` or `data/processed/`. I changed
      `scripts/clean_data.py`, reran `npm run data:clean`, and committed all
      three artifacts together.
- [ ] Pasted `npm run data:inspect` before and after
- [ ] Pasted `git diff --stat -- public/data data/processed` and explained any
      change in the published counts
- [ ] If a validation rule changed, cited the rows that motivated it
- [ ] If `SCHEMA` in `validate_data.py` moved, said whether the pipeline changed
      or the upstream data changed

### If this changes the map, the app or the contract

- [ ] Still works at a repository subpath (`VITE_BASE_PATH=/repo/`) and at the
      domain root
- [ ] No new runtime npm dependency, or the pull request explains why the three
      existing ones are not enough
- [ ] No new Python dependency in the pipeline (standard library only)
- [ ] No new `console.log`, no `@ts-ignore`, no non-null assertion I did not
      check
- [ ] Responsive and keyboard-navigable, and unchanged for anyone not using the
      feature

## What this does not do

- [ ] No ratings, reviews, hours, menus, prices, cuisines, photos or rankings
- [ ] No recommendations or generated summaries
- [ ] No accounts, sign-in, cookies, analytics or tracking
- [ ] No proprietary, scraped or gated data source
- [ ] No vendored basemap style JSON
- [ ] No hard-coded secret, token or API key

If any of those boxes cannot be ticked, please open an issue first rather than
the pull request.

## Screenshots

<!-- Only for UI changes. Before/after if it is a visual fix. -->
