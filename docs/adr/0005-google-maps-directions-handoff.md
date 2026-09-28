# 0005. Hand directions to Google Maps over a web URL

**Status:** Accepted
**Date:** 2026-09-28

Supersedes the provider-neutrality of the directions handoff, which was never
recorded as an ADR in its own right and now lives only in the source comments of
[`src/components/DirectionsLink.tsx`](../../src/components/DirectionsLink.tsx).
[ADR 0003](0003-keyless-basemap-three-runtime-deps.md) is untouched: it governs
the basemap, and this is a link handoff, not a basemap.

## Context

The detail sheet has always carried a "Directions" link. It emitted an RFC 5870
`geo:` URI, on the reasoning that a vendor-neutral scheme lets iOS resolve to
Apple Maps and Android to Google Maps, and a fork could repoint one function.

That reasoning was sound but the scheme does not work on the platform most
visitors use. `geo:` is an OS-level scheme: iOS hands it to Apple Maps, Android
to Google Maps, and **a desktop browser cannot resolve it at all**. The link was
a dead click on a laptop, with no JavaScript fallback — `DirectionsLink` is a
plain `<a href>` and nothing intercepts the click.

The alternative the neutrality was protecting against — an API key, an account,
a vendor SDK — turns out not to apply. Google documents
[Maps URLs](https://developers.google.com/maps/documentation/urls/get-started)
as requiring no API key: a `https://www.google.com/maps/dir/?api=1&…` link is
an ordinary web URL that opens the Google Maps app on a device and the Maps web
app on a desktop. Nothing is embedded, nothing is fetched by this app, and
nothing about the fork changes.

## Decision

**The "Directions" link opens a Google Maps URLs directions link, in the web.**

`buildDirectionsUrl` emits:

```
https://www.google.com/maps/dir/?api=1&destination=<lat>,<lng>&travelmode=walking[&origin=<lat>,<lng>]
```

- **`destination` is the coordinates, not the address string.**
  [`contributing.md`](../contributing.md#reporting-a-problem-instead-of-fixing-it)
  records that the address can be wrong while the coordinates come from DOT's
  geocoder, so the coordinates are the more trustworthy half. Google has no
  documented way to attach a business name to a coordinate destination, so the
  name appears in the link's own visible and accessible text instead, and the
  pin on Google's side carries no label.
- **`travelmode=walking` is fixed.** Google defaults to driving, which is the
  wrong default for a map of sidewalk and roadway dining. The app still does
  not route and does not draw a route — it hands over and gets out of the way —
  but the mode it asks for is the one the feature is about.
- **`origin` is present only when the visitor has explicitly tapped "Near me".**
  See the consequences below; this is the uncomfortable one.
- **No `utm_*` parameters.** Google suggests them, and they are analytics. The
  no-tracking promise outranks the suggestion.
- It remains an `<a href>` with `target="_blank"` and `rel="noopener noreferrer"`.
  An anchor is announced as a link, is keyboard-reachable, needs no popup
  permission, and works with the popup API unavailable.

This is a change to the **link handoff only**. The basemap, the geocoder, the
data source, the frozen contract, the three runtime dependencies and the
standard-library pipeline are all unchanged.

## Alternatives considered

### Keep the `geo:` URI

- Pros: vendor-neutral, no vendor named in the URL, iOS visitors keep Apple Maps.
- Cons: **it does not work on desktop.** That is the defect this decision fixes.
  Neutrality bought an OS scheme that a browser cannot resolve.
- Rejected: the primary platform for a licence map people read on a laptop is
  the one where the link did nothing.

### Two links — `geo:` and Google — both in the sheet

- Pros: nobody loses anything; a visitor can pick.
- Cons: two controls doing one job, and the choice is invisible until you read
  both. A visitor who taps the wrong one gets a worse result than if there had
  been one link. It also doubles the test surface for a feature with no
  configuration.
- Rejected: adds UI cost to fix a problem that only exists because the other
  option is dead on desktop.

### Choose the provider with an env var, like `VITE_BASEMAP_STYLE_URL`

- Pros: preserves forkability, mirrors the basemap seam exactly.
- Cons: two code paths, two sets of expectations, and a default that still has
  to be right. The basemap env var exists because the basemap has no working
  free default; this one does.
- Rejected: a second seam for a decision that is not actually contested. It
  stays trivial to fork — one function, one constant.

### Embed the Google Maps JavaScript API

- Rejected immediately: it needs a key and an account, so a fork 404s on first
  load. This is [ADR 0003](0003-keyless-basemap-three-runtime-deps.md)'s
  original rejection of Google as a basemap, and it is why this decision is a
  plain link instead.

## Consequences

- **The handoff is no longer vendor-neutral.** A fork that wants a different
  provider still changes exactly one function, `buildDirectionsUrl`, but it
  also has to edit `tests/directions.test.tsx`, because the tests now pin the
  Google URL. That is the real cost, and it is the reason this is a decision
  record rather than a one-line change.
- **iOS visitors without Google Maps installed fall back to the browser** rather
  than Apple Maps. They get working directions in Maps web, not turn-by-turn in
  their native app. This is a genuine regression for those visitors and is the
  strongest argument against this decision.
- **A visitor who has tapped "Near me" discloses their position to Google when
  they click the link.** `useGeolocation` keeps the fix in React state, out of
  the URL and out of storage, and the header of that module promises the fix is
  ephemeral. An `href` is the one place that promise ends: the coordinates are
  in the URL the browser sends. It is disclosed deliberately, on an explicit
  click, to a party the visitor is already being handed to, and it is the only
  moment the app puts the fix anywhere but memory. A fork that would rather not
  make that disclosure drops the `origin` parameter — one line.
- **"No Google" in the Never list means no Google *data*.** No key, no account,
  no SDK, no Places, no scraping, and nothing rendered from Google's response.
  The forkability promise is intact: clone, `npm install`, deploy, no secrets.
  `AGENTS.md` and `contributing.md` link here so the distinction is visible.
- The URL stays far under Google's 2,048-character limit; the longest case is a
  15-character label plus two coordinate pairs.
- A business name no longer survives the handoff as a Google pin label. The
  coordinate is exact and the name is on screen in this app, which is the
  trade this decision accepts.

## Where this lives

- Builder: `buildDirectionsUrl` in
  [`src/components/DirectionsLink.tsx`](../../src/components/DirectionsLink.tsx)
- Call site: [`src/components/DetailSheet.tsx`](../../src/components/DetailSheet.tsx)
- Tests: [`tests/directions.test.tsx`](../../tests/directions.test.tsx)
