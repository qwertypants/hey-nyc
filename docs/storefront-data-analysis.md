# Storefront Pulse: live data analysis

**Status:** First implementation milestone complete and independently reviewed; architecture not approved.
**Research date:** October 3, 2026. **Source rows updated:** April 9, 2026, 14:31:46 UTC.
**Scope:** Section 48 of the supplied Storefront Pulse plan: inspect the live source, answer the eleven data questions, then stop for architectural review. No app, ETL, generated map artifacts, refresh workflow or historical transitions have been implemented.

## Source and reproducibility

Source: [Storefronts Reported Vacant or Not, 92iy-9c3n](https://data.cityofnewyork.us/City-Government/Storefronts-Reported-Vacant-or-Not/92iy-9c3n), NYC Department of Finance. Live metadata: [Socrata view metadata](https://data.cityofnewyork.us/api/views/92iy-9c3n.json).

The accompanying [query evidence](storefront-data-evidence.json) preserves query URLs, retrieval timestamps and raw results. Counts are source rows, not deduplicated storefronts. Grouped queries cover the whole dataset unless a query explicitly contains a limit or filter. Samples and ranked examples are not exhaustive. Independent root totals were checked against the schema agent's results. Requests are separate API reads, not a transactionally frozen snapshot.

The dataset describes owner-reported ground-floor and second-floor commercial premises. Annual and supplemental reporting have different coverage; the [DOF registration requirements](https://www.nyc.gov/site/finance/property/storefront-registry-requirement.page) distinguish tax classes and reporting obligations. Reported vacancy does not establish present availability, leasability, business closure or business viability.

## 1–4. Reporting periods, vacancy and coordinates

There are **414,884 rows across seven reporting labels**. `reporting_year` is text, not an integer. Metadata describes the old paired labels as a December 31 primary registration plus the following June 30 supplemental registration. Preserve the literal label and both observation fields; do not silently coerce a paired label into a single year.

| Source reporting label | Rows | Dec 31 yes (YES/Y) | Dec 31 no | Dec 31 missing | June/sale yes | Coordinates present |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 2019 and 2020 | 75,250 | 6,940 | 68,310 | 0 | 3,884 | 69,418 |
| 2020 and 2021 | 75,540 | 8,542 | 66,998 | 0 | 3,258 | 75,540 |
| 2021 and 2022 | 63,456 | 6,613 | 56,843 | 0 | 1,696 | 63,323 |
| 2022 and 2023 | 64,092 | 6,163 | 57,929 | 0 | 2,053 | 64,056 |
| 2023 | 65,419 | 8,048 | 57,335 | 36 | 0 | 65,419 |
| 2024 | 66,668 | 7,708 | 56,740 | 2,220 | 2,220 | 66,665 |
| 2025 | 4,459 | 2,284 | 0 | 2,175 | 2,175 | 4,459 |

**Newest is not necessarily a comparable cohort.** The 2025 label has 4,459 rows: 2,284 December-yes records and 2,175 June/sale-yes records, with no explicit December-no records. Its population cannot support a citywide vacancy share. The 2024 cohort has 66,668 rows including 2,220 without December status. Choosing a default is an architectural decision, not `max(year)`.

`vacant_on_12_31` defines NO as owner-occupied or leased. Use **reported non-vacant**, not “active business.” Observed positive variants are YES and Y. `vacant_6_30_or_date_sold` has only YES and missing values; missing means no reported information, not NO. Do not overwrite December status using a blank June field, or sum the two yes totals as unique storefronts.

Coordinates are populated on 408,880 rows (98.55%); 6,004 lack them. Another 5,923 rows have exactly `(0, 0)` coordinates: 5,815 in “2020 and 2021,” 19 in “2023,” 81 in “2024” and eight in “2025.” A broad diagnostic box (latitude 40.4–41.0, longitude −74.3–−73.6) flags exactly those 5,923 rows. Excluding missing and zero pairs leaves 402,957 candidate points (97.13%), before deduplication or exact boundary validation. The box is a diagnostic, not an approved NYC polygon or publication rule. Non-null coverage is not a coordinate-validity or storefront-entrance accuracy assertion. Missing coordinates should exclude a row from points, with a counted reason, while preserving it in clearly defined reported-record summaries.

## Live schema

All 27 public fields observed in the live metadata are listed below. Four additional computed-region columns are present in metadata; none documents a stable storefront identity.

| API field | Socrata type | Source label |
| --- | --- | --- |
| `filing_due_date` | calendar_date | Filing Due Date |
| `reporting_year` | text | Reporting Year |
| `borough_block_lot` | text | Borough Block Lot |
| `property_street_address_or` | text | Property Street Address or Storefront Address |
| `borough` | text | Borough |
| `zip_code` | text | Zip Code |
| `sold_date` | calendar_date | Sold Date |
| `vacant_on_12_31` | text | Vacant on 12/31 |
| `construction_reported` | text | Construction Reported |
| `vacant_6_30_or_date_sold` | text | Vacant 6/30 or Date Sold |
| `primary_business_activity` | text | Primary Business Activity |
| `expir_dt_of_most_recent_lease` | calendar_date | Expiration date of the most recent lease |
| `property_number` | text | Property Number |
| `property_street` | text | Property Street |
| `unit` | text | Unit |
| `borough_1` | text | Borough1 |
| `postcode` | text | Postcode |
| `latitude` | number | Latitude |
| `longitude` | number | Longitude |
| `lat_long` | point | Lat/Long |
| `community_board` | text | Community Board |
| `council_district` | text | Council District |
| `census_tract` | text | Census Tract |
| `bin` | text | BIN |
| `bbl` | text | BBL |
| `nta` | text | NTA |
| `nbhd` | text | NTA Neighborhood |

Do not confuse reported `borough_block_lot` with geocoded `bbl`, reported `zip_code` with geocoded `postcode`, or the reported address with `property_number`/`property_street`/`unit`. Fallbacks require explicit provenance and disagreement counts. The `borough_1` description incorrectly calls it a ZIP code, and `primary_business_activity` has a supplemental-vacancy description. These are source metadata inconsistencies, not permission to reinterpret the values.

## 5–7 and 11. Property identity, duplicates and cross-period stability

There are **50,510 distinct reported BBL values** across the whole dataset. The geocoded BBL field also has 50,510 distinct values, which does not prove pairwise agreement between the fields. No public field in the metadata is a documented storefront identifier. BBL and BIN describe properties/buildings.

| Source reporting label | Distinct reported BBLs | Distinct raw BBL/address pairs | Repeated BBL/address groups | BBLs with multiple raw addresses |
| --- | ---: | ---: | ---: | ---: |
| 2019 and 2020 | 35,129 | 49,311 | 11,840 | 5,154 |
| 2020 and 2021 | 35,628 | 50,788 | 11,538 | 5,610 |
| 2021 and 2022 | 29,586 | 42,021 | 9,823 | 4,526 |
| 2022 and 2023 | 29,988 | 42,324 | 10,031 | 4,554 |
| 2023 | 30,565 | 31,465 | 12,597 | 716 |
| 2024 | 29,834 | 41,702 | 10,661 | 4,737 |
| 2025 | 2,150 | 2,868 | 785 | 553 |

“Repeated groups” counts distinct BBL/address pairs with more than one source row, not excess rows and not proven duplicate storefronts. Raw address strings are compared exactly, including capitalization, spacing and abbreviations. Grouped retrieval was ordered by BBL/address and paginated at 50,000 groups. These counts reconcile to each period's independent row and distinct-BBL queries. They do not validate a normalized identifier.

Examples: BBL `2039291001` has 79 rows in “2021 and 2022,” including 54 with `62 Parkchester Road`. BBL `2051410006` has 59 rows with `200 BAYCHESTER AVENUE` in “2019 and 2020.” Distinct addresses within one BBL can describe multiple storefronts, address variants, or reporting inconsistencies; repeated pairs can also describe multiple storefronts. Dropping all but one row per BBL/address would lose unquantified information.

Only 43,888/414,884 rows (10.58%) have a non-null `unit`. Presence does not establish that a unit is unique, consistently reported or storefront-specific. A BBL + address + unit recipe remains a hypothesis, not an approved stable identity. Exact repeats of all published source fields also require investigation: without a source premises ID, byte-identical records can be indistinguishable reports of separate spaces. This milestone does not establish a safe deletion policy.

### Distribution of reported records per BBL

These are rows per property within each cohort, not validated storefront counts.

| Source reporting label | Mean | Median | 90th percentile | Maximum | BBLs with >1 row |
| --- | ---: | ---: | ---: | ---: | ---: |
| 2019 and 2020 | 2.142 | 1 | 4 | 78 | 15,243 |
| 2020 and 2021 | 2.120 | 1 | 4 | 59 | 15,310 |
| 2021 and 2022 | 2.145 | 1 | 4 | 79 | 12,779 |
| 2022 and 2023 | 2.137 | 1 | 4 | 79 | 13,069 |
| 2023 | 2.140 | 1 | 4 | 113 | 12,741 |
| 2024 | 2.235 | 1 | 5 | 113 | 13,084 |
| 2025 | 2.074 | 1 | 4 | 66 | 1,052 |

Across all periods combined, the mean is 8.214 rows per BBL, median 5, 90th percentile 18, and maximum 330. That distribution includes repeated reports over time and must not be presented as simultaneous storefront counts.

A targeted sample query grouped 26 scalar source fields (all public fields except the redundant `lat_long` point) at BBL `2039291001`, “2021 and 2022.” It found groups of 16 identical scalar reports for `62 Parkchester Road`, unit `S1-3`, NO vacancy/RETAIL, and 15 for the same address/unit with YES vacancy/NO BUSINESS ACTIVITY IDENTIFIED. This proves identical published attributes occur; it does not prove that deleting those records preserves distinct premises. The test was limited to one property and the ten largest repeated groups, not a full-dataset duplicate census.

### Address stability across adjacent source labels

| Source label comparison | Common BBLs | BBLs with any exact address overlap | BBLs without exact overlap |
| --- | ---: | ---: | ---: |
| 2019 and 2020 -> 2020 and 2021 | 28,882 | 20,141 | 8,741 |
| 2020 and 2021 -> 2021 and 2022 | 24,748 | 21,099 | 3,649 |
| 2021 and 2022 -> 2022 and 2023 | 24,392 | 22,011 | 2,381 |
| 2022 and 2023 -> 2023 | 24,540 | 15,215 | 9,325 |
| 2023 -> 2024 | 25,770 | 10,846 | 14,924 |
| 2024 -> 2025 | 1,884 | 1,385 | 499 |

These are property-level raw-address overlap diagnostics, not matched storefronts or comparable observation periods. They intentionally do not correct capitalization or abbreviations. For example, a shared BBL changes `738 EAST 182 ST.` to `738 East 182 St.`; another changes `43-01 QUEENS BOULEVARD`/`4303 QUEENS BLVD` to `4301 QUEENS BOULEVARD`/`4303 QUEENS BOULEVARD`. Such differences are not evidence of businesses opening or closing. Conversely, an exact address overlap does not resolve many-to-one storefront ambiguity.

A diagnostic lowercase/punctuation/whitespace comparison raises property-level address overlap between 2023 and 2024; this still does not establish one-to-one premises identity. The evidence records the diagnostic separately from exact overlap. No normalization is approved for production by this experiment.

**Can the same storefront reliably be identified across periods? Not yet.** There is no documented source storefront key, BBL/address pairs collide within periods, units are sparse, addresses drift, and reporting cohorts differ. Phase 2 must establish a one-to-one subset with an explicit ambiguity/rejection policy and publish matching coverage before reporting transitions. For Explore, a deterministic ID can identify a published record without claiming it identifies a persistent physical storefront; its exact recipe and collision rules require the contract/ADR review.

## 8. Business activity

The source already has manageable literal categories; no classification model is needed. Preserve the raw value. Any later deterministic display mapping should be reviewed and retain a missing/unspecified distinction.

| Raw value | Rows |
| --- | ---: |
| RETAIL | 108,179 |
| FOOD SERVICES | 55,446 |
| NO BUSINESS ACTIVITY IDENTIFIED | 47,320 |
| OTHER | 46,180 |
| EDUCATIONAL SERVICES | 45,098 |
| WHOLESALE | 22,301 |
| MISCELLANEOUS OTHER SERVICE | 20,434 |
| REAL ESTATE | 14,373 |
| HEALTH CARE or SOCIAL ASSISTANCE | 12,935 |
| PUBLISHING | 8,201 |
| FINANCE & INSURANCE | 7,085 |
| (missing) | 7,036 |
| LEGAL SERVICES | 4,493 |
| HEALTH CARE OR SOCIAL ASSISTANCE | 4,213 |
| MANUFACTURING | 3,216 |
| ACCOUNTING SERVICES | 2,639 |
| BROADCASTING/TELECOMM | 2,125 |
| MOVIES/VIDEO/SOUND | 1,426 |
| INFORMATION SERVICES | 1,425 |
| NO BUSINESS ACTIVITY REPORTED | 759 |

**Semantic drift warning:** FOOD SERVICES falls from 13,665 in “2022 and 2023” to 30 in “2023” and 31 in “2024,” while EDUCATIONAL SERVICES rises from 937 to 20,495 and 20,400. These are measured changes, not established changes in NYC businesses. A categorization/encoding or cohort issue is possible but not proven. Do not silently repair or market these as commercial transitions. Defer the business-activity filter until the discrepancy is understood; show a qualified raw reported value only if review accepts it.

## 9–10. Geographic and lease coverage

| Field | Present | Missing | Present share |
| --- | ---: | ---: | ---: |
| NTA | 414,433 | 451 | 99.89% |
| NTA neighborhood name | 414,436 | 448 | 99.89% |
| Reported ZIP | 411,586 | 3,298 | 99.21% |
| Geocoded postcode | 414,877 | 7 | 100.00% |
| Lease expiration | 69,933 | 344,951 | 16.86% |
| Business activity | 407,848 | 7,036 | 98.30% |
| Construction | 12,382 | 402,502 | 2.98% |

These are non-null measures; non-null sentinel strings and dates still need inspection before publication. Lease coverage is 0 in the four oldest cohorts, 64,607/65,419 in 2023, 2,829/66,668 in 2024 and 2,497/4,459 in 2025. Completeness and usefulness are different.

NTA codes change format between “2021 and 2022” and “2022 and 2023.” Earlier records contain four-character codes such as MN17; later ones contain six-character codes such as MN0502. Twelve “2020 and 2021” records have the literal NTA value `0`; 99.89% non-null therefore overstates usable NTA coverage. DCP's [2010 NTA map](https://www.nyc.gov/assets/planning/download/pdf/planning-level/nyc-population/census2010/ntas.pdf) and [2020 NTA metadata](https://s-media.nyc.gov/agencies/dcp/assets/files/pdf/data-tools/bytes/nynta2020_metadata.pdf) document distinct geographies. Their boundaries are statistical approximations, not definitive neighborhood boundaries. A single boundary file cannot be assumed to join all periods. Preserve source codes and names, label the vintage, validate joins, and avoid comparing area shares across changed boundaries without an approved method.

Construction has YES/Y, NO/N and missing values. Missing dominates and all 2025 construction fields are missing. Treat missing as unknown; a “Not reported” filter must distinguish unknown from an explicit negative.


### Borough distribution

| Reported borough | Rows |
| --- | ---: |
| MANHATTAN | 155,450 |
| BROOKLYN | 98,069 |
| QUEENS | 89,251 |
| BRONX | 55,286 |
| STATEN ISLAND | 16,828 |

### Lease date anomalies

The 2023 lease dates span May 1, 1967 to December 31, 2099; 42 equal December 31, 2099, and 23,693 are after the research date. The 2024 range is September 30, 1923 to November 30, 2025; the 2025 range is June 10, 1966 to December 31, 2025. A future expiration can be legitimate; a suspicious far-future date is not proven to be a sentinel. Retain source values, report anomalies, and do not silently turn dates into availability or infer prior business activity from an unqualified activity field.

## Architectural review: proposals, not accepted decisions

No authoritative frontend/Python contract is frozen at this milestone. These proposals follow from the measurements and require review before ETL or frontend work.

| Decision | Evidence and proposed direction | Alternative / unresolved cost |
| --- | --- | --- |
| Default reporting cohort | Consider 2024 December status for a broad recent cohort, with missing status counted separately. Retain the literal source label. | Newest label 2025 is vacancy-only and cannot establish a share. Confirm cohort/reporting-date semantics before selecting a default. |
| Status vocabulary | Three states: reported vacant, reported non-vacant, unknown. Keep December and June/sale observations separate. | “Active” asserts more than the NO field establishes; combining observations risks inconsistent dates and duplicate counting. |
| Statistical unit | Count reported records until duplicate handling is validated; show denominators and exclusions explicitly. | Deduplicating a shared address can delete real storefronts, while keeping identical rows may inflate counts. Neither is automatic. |
| Geography | Latest cohorts appear compatible with 2020 NTA codes; verify every join to official DCP boundaries. Keep unknown/unmatched records in reconciliation totals. | Older cohorts use different NTA codes. Cross-period area change needs consistent geography or must be deferred. No invented boundaries. |
| Intermediate cache | Recommend a local SQLite cache using Python `sqlite3`, or gzip JSON, with retrieval metadata and invalidation by source metadata. | The supplied plan requests Parquet, which normally requires a new Python library. This conflicts with ADR 0003 and contributing rules. Parquet requires an explicitly reviewed exception/ADR; no dependency has been added. |
| Business categories | Defer normalized filters until the 2023/24 semantic shift is explained. Preserve literal source values. | A display mapping alone would hide the observed discontinuity. Do not call the value “previous activity” without source support. |
| Publication | Separate storefront artifacts and hashes; precompute summaries, publish a bounded set of point properties, and measure sizes before considering tiles. | Do not append storefronts to `cafes.geojson`, publish all historical rows, or change existing Eat/Walk contracts. |
| History | Defer storefront transitions until identity and comparable reporting cohorts are established. | Address/property matching is useful for research, but cannot by itself establish an individual storefront becoming vacant. |

The new DOF layer and DCP boundaries need an ADR before code under [the decision trigger list](decisions.md#when-you-need-a-new-adr). A substantial implementation also needs an issue before a pull request under [contributing rules](contributing.md#pull-request-process). No issue, PR, deployment or external write has been made by this research run.

## Team execution record and next gate

The repository started clean on `main` at `e2f3c22`. Research is on `codex/storefront-data-analysis`. The root is the sole repository writer. Two smaller agents independently investigated schema/categories and storefront identity using read-only API queries; a third smaller agent reviewed the report against retained evidence. They needed no worktrees because they did not change tracked files. Existing app and generated data remain untouched.

After architectural review, the root owns an ADR, shared Python/TypeScript contracts, fixtures and integration. Only then start ETL, feature lifecycle/URL, and map/UI workers from the committed contract, each in its own branch/worktree with exclusive path ownership. Serialize shared shell integration and artifact regeneration. ETL must prove source/cleaned/published reconciliation, explicit rejection reasons and timestamp-independent content comparisons; frontend must test URL restoration, selections, filter semantics and repeated Eat → Walk → Storefronts switching. An independent verifier checks the integrated app, accessibility, real map behavior, source attribution and measured artifact sizes. Run `npm run verify` before claiming implementation complete.

**Stop here:** the supplied plan's section 48 explicitly says to generate this analysis and then stop for architectural review. Approval of the cohort, observation semantics, record identity/deduplication policy, geography and cache approach is the start gate for subsequent implementation, not an assumed consequence of producing this document.

## Verification of this research deliverable

The independent reviewer found no factual or arithmetic discrepancies after the final identity pass and confirmed all eleven questions are covered. Fresh local checks parsed the retained evidence JSON, reconciled cohort and borough totals to 414,884, reconciled each ordered/paginated identity query to independent annual row and BBL counts, checked repeated-pair excess-row arithmetic and adjacent-address overlap totals, and checked both new files for whitespace/encoding problems. These checks passed. No application tests or build were run: this is a documentation-only research milestone, not an implemented feature. The two new documents are uncommitted on the topic branch.
