# 0009. Keep older NTA summaries without invented boundaries

**Status:** Superseded by [0010](0010-load-storefront-reports-by-period.md)
**Date:** 2026-10-03

## Context

ADR 0008 specified the former DCP 2010 NTA dataset `q2z5-ai38` as a boundary input before its live endpoint was exercised. On October 3, 2026, `https://data.cityofnewyork.us/api/views/q2z5-ai38.json` returned HTTP 404, and the official Socrata catalog search returned the 2010 census tracts but no corresponding NTA polygon dataset. The 2020 NTA metadata endpoint `9nt8-h7nd` is available and supplies `nta2020`, `ntaname`, `boroname` and `the_geom`.

Storefront records still carry the earlier NTA codes. Matching those codes to a different vintage would invent a geographic correspondence. Retaining their source-based aggregates does not require publishing replacement polygon geometry.

## Decision

Supersede [ADR 0008](0008-explore-reported-storefront-records.md), reaffirming all its choices except the requirement to fetch both boundary vintages. The contract in `src/types/storefronts.ts`, writer/validator in `scripts/storefronts/`, frontend in `src/features/storefronts/` and methodology in `docs/storefronts.md` now follow these additional rules:

- Fetch official DCP 2020 NTA polygons from `9nt8-h7nd`; match only 2020 source codes. The default 2024 cohort retains the complete polygon exploration experience, subject to documented unmatched records.
- Earlier 2010-coded cohorts retain their literal NTA codes/names/counts and reported-vacant points. Set `boundaryId` to null. Where valid source coordinates exist, a mean coordinate may anchor an aggregate label; document it as label placement, not a boundary or geographic measurement. A group without coordinates has no map anchor and stays in reconciliation totals.
- Clearly explain that historical-vintage polygons are unavailable in this implementation. Do not draw invented polygons or assert area-level historical trends. Labels/list rows remain selectable without a polygon.
- If official 2010 NTA boundaries become directly available through a dependency-free public format, a new source/geometry ADR can add them after validating the complete join.

## Alternatives considered

### Use the currently published 2020 boundaries for old codes

Rejected: codes and statistical boundaries changed. Joining by similar names would misrepresent the source geography.

### Download an arbitrary ArcGIS mirror

Rejected: public mirrors do not by themselves establish authoritative ownership, release vintage or unchanged geometry. An unsupported replacement would violate the factual-source promise.

### Derive NTA geometry from census tracts or add a shapefile library

Rejected for this Explore milestone: polygon union/projection and historical release validation are additional work, and a library would relax the standard-library pipeline decision. Neither is needed for the default recent-cohort experience.

### Ship only the 2024 cohort

Rejected: the source labels are useful for inspecting reported records even without polygon comparison. Honest labels/points preserve that exploration without implying historical premises matching.

## Consequences

Older periods have selectable summaries and reported points but no neighborhood polygon fills/outlines. Their label anchors depend on mappable reports and are not boundary centroids. This is a visible limitation, not hidden data repair. The pipeline has one boundary source and can operate without a retired endpoint. The remaining data identity, cache, status, refresh, hash and no-dependency decisions in ADR 0008 remain in force through this record.
