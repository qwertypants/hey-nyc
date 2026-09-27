/**
 * The directions handoff.
 *
 * The assertion here is deliberately about the URL and never about a vendor. The whole point
 * of `buildDirectionsUrl` being behind a helper is that a fork can point it somewhere else —
 * an `maps.apple.com` deep link, a `comgooglemaps://` scheme, an internal routing system —
 * without touching a single component or a single test. A test that asserted
 * "contains google.com" would have frozen the exact thing the seam exists to make swappable.
 */

import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { buildDirectionsUrl, directionsTargetFor, DirectionsLink } from '../src/components/DirectionsLink';
import { formatAddress } from '../src/lib/format';
import { FIXTURES, makeProperties } from './helpers/fixtures';

const TARGET = {
  lat: 40.683381,
  lng: -73.966407,
  name: 'EMMY',
  address: '919 FULTON STREET, Brooklyn, NY 11238',
};

describe('buildDirectionsUrl', () => {
  it('emits an RFC 5870 geo: URI carrying both the position and the label', () => {
    const url = buildDirectionsUrl(TARGET);

    // The leading position, then `q` = the same position with the label in parentheses.
    expect(url).toBe(
      'geo:40.683381,-73.966407?q=40.683381,-73.966407(EMMY%2C%20919%20FULTON%20STREET%2C%20Brooklyn%2C%20NY%2011238)',
    );
  });

  it('names no vendor, so iOS and Android each resolve it to their own maps app', () => {
    const url = buildDirectionsUrl(TARGET).toLowerCase();
    for (const vendor of ['google', 'apple', 'openstreetmap', 'mapbox', 'bing', 'yandex']) {
      expect(url).not.toContain(vendor);
    }
  });

  it('never emits exponential notation for a coordinate', () => {
    // A tiny longitude stringifies as "1e-7"; `String()` would produce an unparseable URI.
    const url = buildDirectionsUrl({ ...TARGET, lat: 0.0000001, lng: -0.0000002 });
    expect(url).not.toMatch(/e[+-]/i);
    expect(url.startsWith('geo:0.000000,-0.000000?q=')).toBe(true);
  });

  it('percent-encodes characters that would break the URI', () => {
    const url = buildDirectionsUrl({
      ...TARGET,
      name: 'BEN & JERRY #1 (PIZZA)?',
      address: '1 MAIN ST, NEW YORK, NY 10001',
    });
    const label = url.slice(url.indexOf('?q=') + 3);

    expect(url).not.toContain(' ');
    // `&`, `#` and a second `?` would all truncate or re-split the query.
    expect(url.split('?').length - 1).toBe(1);
    expect(label).toContain('%26');
    expect(label).toContain('%23');
    expect(label).toContain('%3F');
    expect(label).toContain('%28');
    // Only the two delimiters RFC 5870 defines remain unescaped; a paren inside the label
    // would otherwise close the `q` parameter early.
    expect(label.split('(').length - 1).toBe(1);
    expect(label.split(')').length - 1).toBe(1);
    // The label is still recoverable.
    expect(decodeURIComponent(label.slice(label.indexOf('(') + 1, -1))).toBe(
      'BEN & JERRY #1 (PIZZA)?, 1 MAIN ST, NEW YORK, NY 10001',
    );
  });
});

describe('directionsTargetFor', () => {
  it('labels the destination with the name and the full postal address', () => {
    // The EMMY fixture: Brooklyn, no `neighbourhood` value in the source.
    const spec = FIXTURES.find((candidate) => candidate.name === 'EMMY');
    if (spec === undefined) throw new Error('the EMMY fixture is missing');
    const location = makeProperties(spec);

    const target = directionsTargetFor(location, { lat: 40.6834, lng: -73.9664 });
    expect(target.name).toBe('EMMY');
    expect(target.address).toBe('919 FULTON STREET, Brooklyn, NY 11238');
    expect(target.address).toBe(formatAddress(location));
  });
});

describe('DirectionsLink', () => {
  it('is an anchor that opens externally, so it needs no popup permission and no JS', () => {
    render(<DirectionsLink target={TARGET} />);

    const link = screen.getByRole('link');
    expect(link.tagName).toBe('A');
    expect(link).toHaveAttribute('href', buildDirectionsUrl(TARGET));
    // `_blank` without `noopener` would hand the new tab a reference back to this page.
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    expect(link).toHaveTextContent(/opens your maps app in a new tab/i);
  });
});
