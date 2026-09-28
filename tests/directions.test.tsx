/**
 * The directions handoff.
 *
 * These tests pin a Google Maps URL, which is a deliberate narrowing of what used to be
 * possible here. `buildDirectionsUrl` used to emit an RFC 5870 `geo:` URI, and there was a test
 * asserting the URL named no vendor — on the theory that a fork could point it anywhere. That
 * theory did not survive contact with a desktop browser, which cannot resolve `geo:` at all.
 *
 * Pinning the vendor is now the correct assertion, and the fork seam is still one function: a
 * fork that repoints `buildDirectionsUrl` also edits this file, which is the acknowledged cost.
 * See `docs/adr/0005-google-maps-directions-handoff.md`.
 */

import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { buildDirectionsUrl, directionsTargetFor, DirectionsLink } from '../src/components/DirectionsLink';
import { FIXTURES, makeProperties } from './helpers/fixtures';

const TARGET = {
  lat: 40.683381,
  lng: -73.966407,
  name: 'EMMY',
};

describe('buildDirectionsUrl', () => {
  it('emits a Google Maps directions URL that a desktop browser can actually open', () => {
    const url = buildDirectionsUrl(TARGET);

    // The failure this replaces: a `geo:` URI, which iOS resolves to Apple Maps, Android to
    // Google Maps, and a browser cannot resolve at all. An `https:` URL works everywhere, and
    // Maps URLs need no API key.
    expect(url).toBe(
      'https://www.google.com/maps/dir/?api=1&destination=40.683381%2C-73.966407&travelmode=walking',
    );
    expect(url.startsWith('https://')).toBe(true);
  });

  it('asks for walking directions, because Google otherwise defaults to driving', () => {
    expect(buildDirectionsUrl(TARGET)).toContain('travelmode=walking');
  });

  it('sends the coordinates, not the address, because the coordinates are the trusted half', () => {
    // `docs/contributing.md` records that the address can be wrong while the coordinates come
    // from DOT's geocoder. A lat/lng destination also cannot be mis-resolved to a same-named
    // business somewhere else in the five boroughs.
    const params = new URLSearchParams(buildDirectionsUrl(TARGET).split('?')[1]);
    expect(params.get('destination')).toBe('40.683381,-73.966407');
  });

  it('never emits exponential notation for a coordinate', () => {
    // A tiny longitude stringifies as "1e-7"; `String()` would produce a URL Google cannot
    // parse, and the link would open and land nowhere.
    const url = buildDirectionsUrl({ ...TARGET, lat: 0.0000001, lng: -0.0000002 });
    expect(url).not.toMatch(/e[+-]/i);
    expect(url).toContain('destination=0.000000%2C-0.000000');
  });

  it('carries no tracking parameters, because Google suggests them and they are analytics', () => {
    // Google's own docs recommend `utm_source` / `utm_campaign`. The no-tracking promise wins.
    const url = buildDirectionsUrl(TARGET);
    expect(url).not.toContain('utm_');
  });

  it('omits the origin when there is no fix, and never sends an empty one', () => {
    expect(buildDirectionsUrl(TARGET)).not.toContain('origin');
    expect(buildDirectionsUrl(TARGET, {})).not.toContain('origin');
    expect(buildDirectionsUrl(TARGET, { origin: null })).not.toContain('origin');
  });

  it('includes the origin when the visitor has tapped "Near me"', () => {
    // The one disclosure this app makes: the fix that `useGeolocation` keeps in React state
    // becomes a URL the browser sends, and it does so on a deliberate click or not at all.
    const url = buildDirectionsUrl(TARGET, { origin: { lat: 40.7306, lng: -73.9866 } });
    expect(url).toContain('origin=40.730600%2C-73.986600');
  });

  it('cannot be split by a business name, because no user text reaches the query', () => {
    // The old `geo:` builder needed `encodeLabel` to escape `(` and `)`, the delimiters RFC 5870
    // uses to close a label. There is no label any more: the name is not interpolated, so an
    // `&` or a `#` has nothing to escape. This test exists so nobody re-adds one and reintroduces
    // the bug without noticing.
    const url = buildDirectionsUrl({
      ...TARGET,
      name: 'BEN & JERRY #1 (PIZZA)?',
    });
    // Exactly the three parameters the builder sets, and not one more: `api`, `destination`,
    // `travelmode`. A fourth would mean something had started interpolating the name.
    expect(url.split('?').length - 1).toBe(1);
    expect(url.split('&').length - 1).toBe(2);
    expect(url).not.toContain('#');
  });
});

describe('directionsTargetFor', () => {
  it('carries the name and the coordinates', () => {
    const spec = FIXTURES.find((candidate) => candidate.name === 'EMMY');
    if (spec === undefined) throw new Error('the EMMY fixture is missing');
    const location = makeProperties(spec);

    const target = directionsTargetFor(location, { lat: 40.6834, lng: -73.9664 });
    expect(target.name).toBe('EMMY');
    expect(target.lat).toBe(40.6834);
    expect(target.lng).toBe(-73.9664);
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
  });

  it('names the new tab for a screen reader, and says which app it opens', () => {
    // A link that silently opens a maps app is a link a screen-reader user cannot predict.
    render(<DirectionsLink target={TARGET} />);
    expect(screen.getByRole('link')).toHaveTextContent(/opens google maps directions in a new tab/i);
  });

  it('puts the fix in the href only when it is passed', () => {
    const { rerender } = render(<DirectionsLink target={TARGET} options={{ origin: null }} />);
    expect(screen.getByRole('link')).not.toHaveAttribute('href', expect.stringContaining('origin'));

    rerender(<DirectionsLink target={TARGET} options={{ origin: { lat: 40.7306, lng: -73.9866 } }} />);
    expect(screen.getByRole('link').getAttribute('href')).toContain('origin=40.730600%2C-73.986600');
  });
});
