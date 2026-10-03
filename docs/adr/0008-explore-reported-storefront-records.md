# 0008. Explore reported storefront records without claiming premises identity

**Status:** Accepted
**Date:** 2026-10-03

## Context

The Storefront Pulse plan adds DOF dataset `92iy-9c3n` as a third map feature. The [live-source analysis](../storefront-data-analysis.md) measured 414,884 rows across seven reporting labels, not 414,884 current storefronts. The newest label, 2025, has no explicit non-vacant records. BBL/address pairs repeat within periods, units are sparse, and no documented premises identifier exists. Business activity and lease fields change markedly in 2023/24. Source NTA codes switch from 2010 to 2020 geography between reporting cohorts.

The user approved proceeding with Explore after reviewing these limitations. This ADR is additive to ADRs 0001–0003; existing Eat and Walk contracts and hashes stay separate.

## Decision

Implement Storefront Pulse Explore in `scripts/storefronts/`, `src/types/storefronts.ts`, and `src/features/storefronts/`, publishing separate generated artifacts under `public/data/storefronts/`. Reuse the existing feature registry, search, map, URL and accessible shell. Use no new runtime or Python dependencies.

1. **Unit: reported record.** Retain repeated reports rather than merging presumed premises. IDs are deterministic hashes of canonical source values plus an occurrence suffix for identical records, unique within a reporting cohort. IDs identify published reports, not persistent physical storefronts. Reconcile source, cleaned, unmapped and published records explicitly. Report every normalization and every point exclusion.
2. **Periods:** preserve literal `reporting_year` labels. Default to `2024` for December status, an explicitly selected cohort with broad non-vacant coverage. Permit other source labels with coverage warnings; the `2025` vacancy-only cohort has no vacancy-share denominator. A new cohort does not silently change the default.
3. **Status:** December `YES`/`Y` means reported vacant; `NO`/`N` means reported non-vacant; missing means unknown. Preserve June/sale status separately and never treat a blank follow-up as non-vacant or as a replacement for December. Construction is similarly three-valued. Unknown values fail validation instead of becoming false.
4. **Aggregates:** counts describe reported records in a selected cohort. A reported vacancy share is vacant / all reported records, with unknown-status counts shown and an explicit denominator caveat; disable the share for vacancy-only cohorts. Do not rank neighborhoods or recommend businesses. Summaries include unmapped records in reconciliation; missing/invalid geography is shown as unknown rather than invented.
5. **Map detail:** authoritative NTA polygons and aggregate labels at low zoom, clustered vacant reports at neighborhood zoom, individual reported-vacant records at street zoom. Non-vacant/Both filters expose aggregate summaries rather than downloading every occupied report as points. Wording explains this difference. Selected areas and records are shareable. Source geography is joined by code and vintage, never by neighborhood name.
6. **Boundaries:** use official DCP 2010 (`q2z5-ai38`) and 2020 (`9nt8-h7nd`) NTA boundaries, validated against live schemas before fetching, kept separate from DOF statistics. Preserve polygon boundaries; coordinate precision may be reduced for payload size without inventing areas. No cross-vintage area trends.
7. **Cache:** local SQLite via Python `sqlite3`, ignored by git, retains raw JSON rows and retrieval metadata. Ordered Socrata pagination, timeout/retry and bounded development fetches are supported. Bounded downloads must not overwrite production artifacts. An unchanged source-metadata check skips network-heavy fetching; pipeline changes and forced runs bypass that cache gate.
8. **Refresh:** weekly plus manual dispatch; hash the complete material published artifact set, excluding retrieval/source timestamps. A change to older points, summaries, geometry or reporting coverage must move the hash. Validate staged artifacts before replacing the published set. Unsafe schema/count/coordinate/category drift fails without overwriting published files.
9. **Deferred:** individual-storefront historical transitions and category normalization. Display only source-supported raw business/lease values with caveats; never call activity “previous business” or infer availability from a lease expiration.

The TypeScript contract, Python writer/validator, documentation and boundary fixtures move together. Implementations link here and to [contributing rules](../contributing.md); they do not duplicate those rules.

## Alternatives considered

### Treat BBL + normalized address + unit as a storefront ID

Rejected: same-period collisions and sparse units cannot establish one-to-one identity. It would convert report duplication and text drift into apparent openings/closures. Preserve ambiguity and defer history.

### Use the newest year as the default and call NO “active”

Rejected: 2025 has only vacancy-positive observations, while NO includes owner occupancy or leasing. Both choices would assert facts the source does not establish.

### Publish all occupied and historical records as points

Rejected: roughly 415,000 rows would burden a static browser map and suggest a census of current businesses. Precomputed summaries plus vacant points serve Explore within measured performance targets.

### Cache Parquet using pandas/pyarrow

Rejected: requires Python dependencies prohibited by ADR 0003. SQLite preserves source rows, supports bounded/incremental inspection, and ships in the standard library. The cache is an implementation detail, not a browser/backend database.

### Join every cohort to current NTA boundaries or geocode missing records

Rejected: changed statistical boundaries make historical joins incorrect; inferred geography would need extra data and an approved methodology. Preserve the source vintage, count unmatched rows and omit invalid points.

## Consequences

The interface must repeatedly say “reported,” expose coverage and unknowns, and explain why a latest-cohort share or non-vacant individual point may be unavailable. Identical records remain distinct report instances and may overlap on the map. This is less visually tidy but prevents silent deletion of potential premises. The default cohort ages until its replacement is reviewed. Boundary vintages add static artifacts and refresh inputs. History requires a new identity decision backed by measured match coverage before it ships.
