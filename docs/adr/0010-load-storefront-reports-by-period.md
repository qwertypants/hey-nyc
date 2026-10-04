# 0010. Load storefront reports by period

**Status:** Accepted
**Date:** 2026-10-03

## Context

The first complete source build reconciled 414,884 reports and generated 44,472 mappable December-vacancy points. Publishing all periods together produced `areas.json` at 435,560 bytes (73,518 gzip) and `vacant.geojson` at 24,739,698 bytes (2,572,167 gzip). These exceed the supplied Explore plan's initial targets of 250 KB for summaries and 2 MB gzip for vacant points. Most of these reports do not belong to the default 2024 view.

## Decision

Supersede [ADR 0009](0009-keep-older-nta-summaries-without-invented-boundaries.md), reaffirming its decisions and ADR 0008's choices except the all-period initial payload. Partition generated reports and summaries by literal reporting label without dropping records.

- `public/data/storefronts/areas.json` and `vacant.geojson` contain the default 2024 cohort only. Other periods use `periods/<label slug>/areas.json` and `vacant.geojson`; slugs are derived deterministically from validated source labels, never user-supplied paths.
- `metadata.json` carries a required `periodArtifacts` manifest containing `reportingYear`, `areasPath`, and `vacantPath`. Paths are relative to the storefront artifact directory and validated against path traversal/absolute URLs. Global source/published totals and per-period coverage remain global/per-period respectively; defaults do not redefine those totals.
- The browser loads metadata and shared 2020 boundaries once, loads the selected cohort lazily, and caches loaded cohorts. Changing periods displays a loading/error state and never presents the previous cohort's rows as the new cohort.
- The Python writer/validator and TypeScript contract/loader move together. Full material hashes and validation include every manifest artifact, including changes in a period the visitor has not selected. Refresh commits stage all generated period files, including additions/removals, while raw/cache inputs remain excluded.
- Measure each period's raw summary and gzip point size and report them. If a future period exceeds a target, do not silently truncate; fail or introduce a reviewed partition strategy.

Governed files: `src/types/storefronts.ts`, `scripts/storefronts/`, `src/features/storefronts/`, `.github/workflows/refresh-storefronts.yml`, and `docs/storefronts.md`.

## Alternatives considered

### Keep the all-period bundle because gzip is reasonably small

Rejected: it exceeds the measured targets and parses nearly 25 MB of point JSON to render one reporting cohort. A first load pays for history it has not requested.

### Drop older periods, fields or repeated source reports

Rejected: limits source exploration or silently changes the statistical unit. Partitioning preserves the data and the qualified source-supported detail fields.

### Add vector tiles or PMTiles immediately

Rejected: no need for tile infrastructure or a fourth runtime dependency when an ordinary static-file partition resolves the measured initial-load problem.

## Consequences

Period switching has an additional request and needs tested loading/error behavior. The artifact manifest and nested refresh staging become load-bearing contract surfaces. Existing Eat/Walk loading, contracts and hashes remain unchanged. A selected-period cache costs memory only after the user requests that period.
