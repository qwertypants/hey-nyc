/**
 * INTEGRATION NOTES (src/lib/attribution.ts)
 *
 * `DATA_ATTRIBUTION_HTML` is the credit the app is legally required to display for
 * NYC Open Data dataset `fpeh-f7ci`. It lives in `src/lib` (no MapLibre, no React) so the
 * detail sheet, the about panel and Stream C's component tests can all import it without
 * pulling in `maplibre-gl`.
 *
 * `src/map/createMap.ts` passes the same string to MapLibre's `customAttribution`, so the
 * on-screen map credit and any React-rendered credit can never drift apart.
 *
 * The string is a static literal: no user data is ever interpolated into it.
 */

export const DATA_SOURCE_URL =
  'https://data.cityofnewyork.us/Transportation/Dining-Out-NYC-Locations/fpeh-f7ci';

export const DATA_ATTRIBUTION_HTML =
  'Data from <a href="https://data.cityofnewyork.us/Transportation/Dining-Out-NYC-Locations/fpeh-f7ci" target="_blank" rel="noopener noreferrer">NYC Open Data</a> ' +
  '&mdash; "Dining Out NYC Locations", provided by the ' +
  '<a href="https://www.nyc.gov/html/dot/html/home.shtml" target="_blank" rel="noopener noreferrer">NYC Department of Transportation</a>.';

/** Same credit with the tags stripped, for `aria-label` / plain-text contexts. */
export const DATA_ATTRIBUTION_TEXT =
  'Data from NYC Open Data — "Dining Out NYC Locations", provided by the NYC Department of Transportation.';
