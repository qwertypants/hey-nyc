# 0003. A keyless basemap and three runtime dependencies

**Status:** Accepted (retroactive)
**Date:** 2026-09-27

Retroactive. Reconstructed from the initial commit `9c18edd` and the reasoning
that shipped in [`docs/basemap.md`](../basemap.md) and
[`docs/contributing.md`](../contributing.md#what-not-to-add).

## Context

The project's promise is that it is a factual map of a government dataset: every
field on screen came from a named column in a named public dataset. Two things
undercut that promise if they leak in:

1. **A number the source does not have.** Ratings, hours, menus, prices,
   cuisines, photos, rankings. A roadway café's real hours depend on the season.
   Any such field would have to be scraped, inferred or invented, and the site
   would no longer be forkable by a stranger in one click.
2. **A dependency that needs an account.** A Mapbox or Google token, a sign-in, a
   paid geocoder, a proprietary data source. A stranger who clones this cannot
   run it.

So the constraints are: no API key, no registration, no rate limit that needs
negotiating, no scraping, and a licence that permits redistribution.

## Decision

**Basemap:** OpenFreeMap's hosted `positron` style, from
`https://tiles.openfreemap.org/styles/positron`, read through the single
environment variable `VITE_BASEMAP_STYLE_URL`.

**Runtime JavaScript dependencies: three.** `maplibre-gl`, `react`, `react-dom`.
Nothing else ships to the browser.

**Python pipeline: standard library only.** `requirements.txt` has one entry,
`pytest`, and it is test-only. Fetching is `urllib.request`, parsing is `json`.

**Geocoding:** Nominatim, user-initiated only, 1 req/s floor, NYC bounding-box
bias. No keystroke-by-keystroke autocomplete against the public endpoint, per
Nominatim's usage policy. Pressing Enter is the only trigger.

**Attribution is a mechanism, not a string.** The `openmaptiles` source in the
style is declared as a TileJSON **URL**, and MapLibre reads `attribution` from
that TileJSON. Attribution is therefore automatic — *provided* we point at the
published style URL and never hand-roll a style. The app additionally declares
`customAttribution` for the NYC Open Data credit and renders the "Data updated
…" line from `metadata.json`, never a hard-coded date.

**Software is MIT; the data is not.** See
[`data-licensing.md`](../data-licensing.md).

## Alternatives considered

### Mapbox

- Rejected: requires an account and an access token. A fork 404s on first load.

### Google Maps

- Rejected: same, plus a more restrictive licence.

### Protomaps

- Pros: a strong option, self-hostable, good-looking styles.
- Rejected on hosting, not on quality: its hosted daily tiles **and** its free API
  tier both want you to register and configure a key, and Protomaps' own
  positioning is that the hosted service is a paid product. A worse fit for a
  zero-config, fork-and-deploy project. The self-hosted PMTiles build remains the
  documented escape hatch past zoom 14, reachable through the same env var.

### `demotiles.maplibre.org`

- Rejected: a low-traffic documentation endpoint with no availability guarantee.
  A public site pointed at it is a site that breaks.

### Vendoring the style JSON into the repository

- Rejected, and this is the important one. A vendored copy is precisely how the
  OpenStreetMap attribution silently disappears, which would make the project
  non-compliant with the data it is built on. It also means a fork is shipping
  someone else's derived work with no way to update it.

### `pandas` + `requests` for the pipeline

- Pros: familiar, and `requests` has better ergonomics than `urllib`.
- Rejected: a Socrata v2.1 JSON endpoint needs none of it. It would slow the
  daily Action, make `npm run data:refresh` heavier for every fork, and put two
  more packages between a contributor and a working pipeline — for zero
  benefit.

### A fourth runtime dependency for state, storage or routing

- Rejected: there is no backend, no account and no persistence because there is
  nothing to persist. URL state is hand-rolled, and filters are derived from the
  loaded collection. See [`url-state.test.ts`](../../tests/url-state.test.ts).

### Accounts, analytics, ratings, hours, "best of" lists, AI summaries

- Rejected as a class. The source has none of these fields, so every one of them
  is a number this project would have to invent. The full list and the reasoning
  per item is in
  [`contributing.md`](../contributing.md#what-not-to-add).

## Consequences

- The app works at a repository subpath and at a domain root with no
  configuration, because `deploy.yml` derives `VITE_BASE_PATH` from the
  repository name.
- **No SLA.** OpenFreeMap states it aims to cover running costs of its public
  instance through donations. A fork that needs a guarantee should self-host,
  which is one env var and nothing else.
- **`maxzoom` is 14.** The app caps maximum zoom at 16 and uses a deliberately
  low-contrast style so overzoom is less visible. Street-level crispness past
  z14 requires a self-hosted PMTiles build.
- The app must keep rendering the NYC Open Data credit on screen, and must never
  hard-code the data date.
- Adding a runtime dependency is a **decision**, not a chore. It needs an ADR
  that argues why the standard library and the existing three are not enough.
- `console.warn` and `console.error` are allowed because the map layer
  legitimately reports tile and geocoding problems. `console.log` is not.
