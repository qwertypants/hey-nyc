/**
 * The directions handoff. Provider-NEUTRAL by construction.
 *
 * The app does not route. It does not draw a route. It hands the coordinates and the
 * postal address to whatever map app the visitor already uses and gets out of the way. That
 * is the only defensible behaviour for a licence map: the walking route depends on curb
 * regulations we have no data about, so pretending to compute one would be a lie.
 *
 * SWAPPABILITY. `buildDirectionsUrl` is the whole provider decision. It emits an RFC 5870
 * `geo:` URI, which iOS resolves to Apple Maps and Android to Google Maps, so the link
 * carries no vendor in its name. A fork that wants a specific app, or a `maps.apple.com`
 * deep link, changes this one function and nothing else — including the tests, which assert
 * the URL and never the vendor.
 *
 * It is an `<a href>`, not `window.open`. That matters: an anchor is announced as a link,
 * is reachable by keyboard, opens in a new tab without a popup-blocker fight, and works
 * with JavaScript's popup API unavailable.
 *
 * Public surface:
 *   type DirectionsTarget
 *   buildDirectionsUrl(target: DirectionsTarget): string
 *   DirectionsLink(props): JSX.Element
 */

import type { JSX, ReactNode } from 'react';
import { formatAddress } from '../lib/format';
import type { LocationProperties } from '../types/location';
import type { LatLng } from '../lib/distance';

export interface DirectionsTarget {
  readonly lat: number;
  readonly lng: number;
  /** Human label the receiving app shows as the destination name. */
  readonly name: string;
  /** Full postal address, so the receiving app can resolve a street entrance. */
  readonly address: string;
}

const GEOMETRY_PRECISION = 6;

function coordinate(value: number): string {
  return value.toFixed(GEOMETRY_PRECISION);
}

/**
 * `geo:<lat>,<lng>?q=<lat>,<lng>(<label>)`
 *
 * The leading `lat,lng` is the RFC 5870 position the URI is "about"; `q` is what the
 * receiving app actually navigates to, and carries the label. Both coordinates are formatted
 * with `toFixed` rather than `String()` so a value never turns into exponential notation.
 */
export function buildDirectionsUrl(target: DirectionsTarget): string {
  const position = `${coordinate(target.lat)},${coordinate(target.lng)}`;
  return `geo:${position}?q=${position}(${encodeLabel(`${target.name}, ${target.address}`)})`;
}

/**
 * `encodeURIComponent` leaves `(` and `)` alone, and those are exactly the delimiters RFC
 * 5870 uses to close the label. A business called "BEN & JERRY (PIZZA)" would otherwise
 * produce a `q` parameter that ends early and a label the receiving app truncates. Escaping
 * them by hand is the difference between a destination and a wrong turn.
 */
function encodeLabel(label: string): string {
  return encodeURIComponent(label).replace(/\(/g, '%28').replace(/\)/g, '%29');
}

export function directionsTargetFor(
  location: LocationProperties,
  coords: LatLng,
): DirectionsTarget {
  return { lat: coords.lat, lng: coords.lng, name: location.name, address: formatAddress(location) };
}

export interface DirectionsLinkProps {
  readonly target: DirectionsTarget;
  readonly className?: string;
  readonly children?: ReactNode;
}

export function DirectionsLink({ target, className, children }: DirectionsLinkProps): JSX.Element {
  return (
    <a
      className={className ?? 'eoy-button eoy-button--primary'}
      href={buildDirectionsUrl(target)}
      target="_blank"
      rel="noopener noreferrer"
    >
      {children ?? 'Directions'}
      <span className="eoy-visually-hidden">
        {' '}
        (opens your maps app in a new tab)
      </span>
    </a>
  );
}
