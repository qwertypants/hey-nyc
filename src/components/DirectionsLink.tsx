/**
 * The directions handoff. Google Maps, over the web.
 *
 * The app does not route. It does not draw a route. It hands the coordinates to Google Maps
 * and gets out of the way. That is the only defensible behaviour for a licence map: the
 * walking route depends on curb regulations we have no data about, so pretending to compute
 * one would be a lie.
 *
 * WHY A WEB URL. This used to emit an RFC 5870 `geo:` URI, on the theory that a vendor-neutral
 * scheme lets iOS resolve to Apple Maps and Android to Google Maps. `geo:` is an OS-level
 * scheme: a desktop browser cannot resolve it at all, so the link was a dead click on a
 * laptop. Google Maps URLs need no API key — an ordinary `https:` link that opens the app on a
 * device and the Maps web app on a desktop — so naming a vendor costs this project nothing it
 * was relying on. See `docs/adr/0005-google-maps-directions-handoff.md` for the alternatives.
 *
 * THE DESTINATION IS A COORDINATE, NOT AN ADDRESS. `docs/contributing.md` records that the
 * address can be wrong while the coordinates come from DOT's geocoder, so the coordinates are
 * the more trustworthy half of the row. Google has no documented way to label a coordinate
 * destination, so the pin arrives unlabelled and the name is carried by the link's own text.
 *
 * It is an `<a href>`, not `window.open`. That matters: an anchor is announced as a link, is
 * reachable by keyboard, opens in a new tab without a popup-blocker fight, and works with the
 * popup API unavailable.
 *
 * Public surface:
 *   type DirectionsTarget
 *   buildDirectionsUrl(target, options?): string
 *   DirectionsLink(props): JSX.Element
 */

import type { JSX, ReactNode } from 'react';
import type { LocationProperties } from '../types/location';
import type { LatLng } from '../lib/distance';

export interface DirectionsTarget {
  readonly lat: number;
  readonly lng: number;
  /** Human label. Stays on screen; the coordinate destination arrives unlabelled. */
  readonly name: string;
}

/**
 * The visitor's own fix, or null. Only ever set from an explicit "Near me" tap, and only ever
 * passed to Google on the click that opens the link.
 */
export interface DirectionsOptions {
  /** Where the route starts. Omitted when null, and Google works it out for itself. */
  readonly origin?: LatLng | null;
}

/** Google's documented endpoint. The `/dir/` path and the `api=1` key are both required. */
const DIRECTIONS_ENDPOINT = 'https://www.google.com/maps/dir/';

/**
 * ~11 cm of precision at NYC's latitude. Below that a coordinate is noise from the geocoder,
 * and above it the URL carries digits that do not help anyone find a door.
 */
const GEOMETRY_PRECISION = 6;

/**
 * `toFixed`, not `String()`. A longitude of `0.0000001` stringifies to `1e-7`, which is not a
 * coordinate Google can parse — the link would open and land nowhere.
 */
function coordinate(value: number): string {
  return value.toFixed(GEOMETRY_PRECISION);
}

function point(value: LatLng): string {
  return `${coordinate(value.lat)},${coordinate(value.lng)}`;
}

/**
 * `?api=1&destination=<lat,lng>&travelmode=walking[&origin=<lat,lng>]`
 *
 * `URLSearchParams` is what encodes this, and it earns its place: the coordinate comma becomes
 * `%2C` and a space becomes `+`, both of which Google's URL-encoding rules call for, and an
 * `&` or `#` inside any future parameter can never split the query. There is no user text in
 * here any more — the name is deliberately not interpolated — so the escaping question is
 * settled by construction rather than by a helper.
 *
 * `travelmode=walking` is fixed because Google defaults to driving, and a map of sidewalk and
 * roadway dining is not a map of where to park. The app is still not routing anything.
 *
 * `origin` is included only when the visitor has tapped "Near me", which puts their position in
 * a URL their browser then sends. That is the one place the fix in `useGeolocation`'s memory
 * becomes a disclosure, so it happens on a deliberate click or not at all.
 */
export function buildDirectionsUrl(
  target: DirectionsTarget,
  options: DirectionsOptions = {},
): string {
  const params = new URLSearchParams({
    api: '1',
    destination: point(target),
    travelmode: 'walking',
  });

  if (options.origin != null) {
    params.set('origin', point(options.origin));
  }

  // `URLSearchParams` stringifies a space as `+`, which is correct here, but it leaves `:` and
  // `/` alone and those never appear in a query value. The endpoint is the only literal.
  return `${DIRECTIONS_ENDPOINT}?${params.toString()}`;
}

export function directionsTargetFor(location: LocationProperties, coords: LatLng): DirectionsTarget {
  return { lat: coords.lat, lng: coords.lng, name: location.name };
}

export interface DirectionsLinkProps {
  readonly target: DirectionsTarget;
  /** Forwarded to `buildDirectionsUrl` only; the anchor itself is not interactive. */
  readonly options?: DirectionsOptions;
  readonly className?: string;
  readonly children?: ReactNode;
}

export function DirectionsLink({
  target,
  options,
  className,
  children,
}: DirectionsLinkProps): JSX.Element {
  return (
    <a
      className={className ?? 'eoy-button eoy-button--primary'}
      href={buildDirectionsUrl(target, options)}
      target="_blank"
      rel="noopener noreferrer"
    >
      {children ?? 'Directions'}
      <span className="eoy-visually-hidden">
        {' '}
        (opens Google Maps directions in a new tab)
      </span>
    </a>
  );
}
