# Storefront Pulse data

Explore counts **reported records**, never distinct premises or current businesses.
See [ADR 0008](adr/0008-explore-reported-storefront-records.md),
[ADR 0009](adr/0009-keep-older-nta-summaries-without-invented-boundaries.md),
[ADR 0010](adr/0010-load-storefront-reports-by-period.md),
[the source analysis](storefront-data-analysis.md) and
[contributing rules](contributing.md).

## Reproduce and validate

```sh
python3 scripts/storefronts/refresh.py
python3 scripts/storefronts/refresh.py --force
python3 scripts/storefronts/refresh.py --offline
python3 scripts/storefronts/inspect.py
python3 scripts/storefronts/validate.py --strict
```

The standard-library SQLite cache is `data/cache/storefronts/source.sqlite3`.
`--offline` rebuilds from the retained snapshots without network access. `--force`
refetches even when metadata matches. Python source changes invalidate the cache
skip gate. `--cache PATH` and `--output-dir DIR` support isolated fixtures and
verification. `--limit` is deliberately refused for publication. Metadata and
required field types are checked before retrieval, rows are ordered by Socrata
`:id` and fetched in 10,000-row pages, and metadata is checked again afterwards.
Reads have a 90-second timeout and four retry attempts. An interrupted read never
replaces a cache snapshot.

`public/data/storefronts/metadata.json`, `areas.json`, `vacant.geojson` and
`boundaries.geojson` are generated together. The report is
`data/processed/storefronts/report.json`. Publication validates a sibling staging
directory and stages the report before replacing the old directory. For the
separate production report, both old outputs are backed up until both replacements
succeed; a report write or replacement failure restores the previous public
artifacts and report together. An existing recovery backup stops publication.
Materially unchanged runs preserve public files and a consistent report, including
retrieval timestamps. A missing, corrupt or stale report is repaired with an atomic
temporary-file replacement even when the public material hash is unchanged. This
repairs an inconsistent baseline left by an older pipeline without public-file
churn; the repair retains the published metadata timestamps.

## Contract and interpretation

The browser contract is [src/types/storefronts.ts](../src/types/storefronts.ts).
December YES/Y becomes `vacant`, NO/N becomes `nonVacant`, and missing becomes
`unknown`. Follow-up June/sale status stays independent. Construction is true,
false or null. Unexpected status or borough values are fatal. Raw activity and
lease/sale/filing date strings are retained; activity has known cohort encoding
ambiguity and does not establish previous activity. Dates are validated but never
used to infer availability. Reported address, ZIP and BBL have no geocoded fallback.

A report ID is `sf-<24 lowercase hexadecimal SHA256 characters>-<positive
occurrence>`. The digest covers canonical UTF-8 JSON of all 27 public DOF source
fields, keys sorted, missing fields represented by null, no whitespace. Identical
rows receive consecutive occurrence suffixes and remain separate. Hash collisions
between distinct source payloads are fatal. Source-computed region fields do not
establish identity. A point ID is a published report instance, not a premises ID.

Area IDs are `area-<24 lowercase hexadecimal SHA256 characters>`, over canonical
JSON `[reportingYear, sourceNtaOrNull, vintageOrNull, reportedBorough]`.
Summaries retain unmappable records. Sparse count cells are
`[DecemberStatus, constructionBooleanOrNull, records, mappableRecords]`; omitted
cells mean zero, never unknown. Coverage totals reconcile every source record and
all point counts. `unknownNtaRecords` means missing/invalid-format source codes.
Missing boundary polygons are separately counted by `recordsWithoutBoundary` in
the report. No names are used as join keys.

Four-character source NTA codes use vintage 2010; six-character codes use 2020.
Only official 2020 DCP `9nt8-h7nd` boundaries are currently available. The retired
2010 `q2z5-ai38` endpoint returns HTTP 404. Historical 2010 areas preserve source
NTA/name/borough, have a null boundaryId and use the arithmetic mean (computed with math.fsum for stable cross-version output) of valid
source report coordinates for label placement. This anchor is neither an official
centroid nor a new boundary. Unknown codes have no invented geometry. 2020 labels
use the bounds midpoint of their matched official polygons. Every boundary vertex
and ring is preserved with coordinates rounded to six decimals. Point coordinates
are rounded to seven decimals. No point-in-polygon assertion or entrance-location
accuracy is inferred.

Missing, invalid numeric/geographic-range and `(0,0)` coordinates are excluded
from points with separate counted reasons, while their records remain in
summaries. Points contain only December-reported-vacant records. Non-vacant and
unknown records are available as aggregate counts. The default is literal `2024`.
The vacancy share is vacant / all reported records, including unknowns; cohorts
without an explicit non-vacant population, including `2025`, cannot support it.

## Change detection and safety

`contentHash` hashes canonical JSON containing complete areas, vacant points,
boundaries and metadata, excluding only contentHash, retrievedAt and each source's
updatedAt. Source identities, names and URLs, methodology/schema versions, all
coverage, older cohort records and every boundary coordinate remain material. The required
periodArtifacts manifest and every referenced period payload are hashed as well.
Corruption of any artifact, even a newly added field, fails validation. Counts,
unique IDs, geometry, allowed categories, boundary joins and matrix/coverage
reconciliation are checked independently of the hash.

Refresh refuses a removed existing cohort or a greater than 5% change in its
source or mappable record count. This conservative guard tolerates corrections
above the measured 1.45% missing-coordinate rate but catches bulk loss. It is an
operator gate, not proof that lesser changes are correct. Investigate upstream
changes before updating the baseline; `--force` does not bypass validation or the
drift guard. History and business category normalization remain deferred.

## Period payloads and measured first publication

The complete source snapshot has 414,884 records, seven literal reporting labels,
and 44,472 mappable December-reported-vacant point instances. Generated sizes are
72,459 bytes raw / 13,880 bytes gzip for default 2024 areas, 4,188,319 bytes raw /
422,949 bytes gzip for default vacant points, and 2,675,935 bytes raw / 630,245
bytes gzip for shared 2020 boundaries. All cohorts and repeated records are
preserved. Per [ADR 0010](adr/0010-load-storefront-reports-by-period.md),
metadata.periodArtifacts identifies each literal cohort and its relative areasPath
and vacantPath. The default 2024 uses the root areas.json/vacant.geojson; others
use periods/<label-with-spaces-replaced-by-hyphens>/areas.json and vacant.geojson.
The largest period areas file is 72,459 bytes raw; the largest vacant payload is
4,515,730 bytes raw / 427,504 bytes gzip. Every cohort meets the 250 KB raw areas
and 2 MB gzip vacant targets. Metadata sourceRows and publishedVacantLocations
remain global; cohort coverage explains the selected period denominator.
