/**
 * Geolocation. The rules under test, in order of how much they matter:
 *
 *   1. The app NEVER asks on load. A map that silently requests your position is a map you
 *      cannot trust, and the permission prompt arriving unbidden is the single most common
 *      reason people dismiss web maps. The only trigger is the Near Me button.
 *   2. Denial, unavailability and timeout are NON-BLOCKING. The map, the list and search all
 *      keep working, the message is dismissible, and there is no modal anywhere.
 *   3. Success is ephemeral: centre, zoom to a walkable level, show a user indicator, offer a
 *      way to turn it off, and never write the position into the URL.
 */

import { describe, expect, it } from 'vitest';
import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  TimesSquareLocation,
  makeGeolocation,
  renderApp,
  restoreNavigatorGeolocation,
  stubNavigatorGeolocation,
} from './helpers/render';
import { LABEL_STYLE } from '../src/map/style';
import { formatDistance, haversineMiles } from '../src/lib/distance';
import { DEFAULT_VIEW } from '../src/lib/urlState';

const NEARBY_ZOOM = LABEL_STYLE.minZoom;

describe('geolocation', () => {
  it('never asks for a position on load, and only the Near Me control asks at all', async () => {
    const user = userEvent.setup();
    const geolocation = makeGeolocation('granted');
    renderApp({ geolocation });

    // Mount, load the dataset, create the map, run every effect.
    await screen.findAllByText(/3 places in this area/i);
    expect(geolocation.callCount()).toBe(0);

    // Neither a filter change, a search, nor a view switch is a reason to ask. The rail
    // replaced a popover, so a filter is now a single tap with no disclosure to open first.
    await user.click(screen.getByRole('radio', { name: /^Roadway dining/ }));
    await user.click(screen.getByRole('radio', { name: /^list/i }));
    await user.click(screen.getByRole('radio', { name: /^map/i }));
    expect(geolocation.callCount()).toBe(0);

    // The one and only trigger.
    await user.click(screen.getByRole('button', { name: /near me/i }));
    await waitFor(() => {
      expect(geolocation.callCount()).toBe(1);
    });
  });

  it('asks for a position and never before, even with a real navigator.geolocation', async () => {
    const user = userEvent.setup();
    const geolocation = makeGeolocation('granted');
    stubNavigatorGeolocation(geolocation);

    try {
      // No prop seam: this exercises the real `navigator` read inside `useGeolocation`.
      const app = renderApp({});
      await screen.findAllByText(/3 places in this area/i);
      expect(geolocation.callCount()).toBe(0);

      await user.click(screen.getByRole('button', { name: /near me/i }));
      await waitFor(() => {
        expect(screen.getByText(/using your location/i)).toBeInTheDocument();
      });
      expect(geolocation.callCount()).toBe(1);
      expect(app.geocodeCalls()).toEqual([]);
    } finally {
      restoreNavigatorGeolocation();
    }
  });

  it('on success: centres, zooms to a walkable level, and shows a turn-off indicator', async () => {
    const user = userEvent.setup();
    const app = renderApp({ geolocation: makeGeolocation('granted') });
    await screen.findAllByText(/3 places in this area/i);

    await user.click(screen.getByRole('button', { name: /near me/i }));

    // Fly, not a fit: the visitor's own position is a point, not an extent.
    await waitFor(() => {
      expect(app.controller().calls.flyTo).toHaveBeenCalledWith({
        lng: TimesSquareLocation.lng,
        lat: TimesSquareLocation.lat,
        zoom: NEARBY_ZOOM,
      });
    });
    expect(app.controller().getState().view.zoom).toBe(NEARBY_ZOOM);

    // A visible, non-georeferenced indicator with a way out.
    const chip = screen.getByText(/using your location/i);
    expect(chip).toBeInTheDocument();
    expect(chip.closest('.eoy-user-chip')).not.toBeNull();

    await user.click(screen.getByRole('button', { name: /turn off/i }));
    await waitFor(() => {
      expect(screen.queryByText(/using your location/i)).not.toBeInTheDocument();
    });
  });

  it('measures distance from the visitor fix, and omits it entirely when there is none', async () => {
    const user = userEvent.setup();
    renderApp({ geolocation: makeGeolocation('granted') });
    await screen.findAllByText(/3 places in this area/i);
    await user.click(screen.getByRole('radio', { name: /^List/ }));

    const distanceOf = (name: RegExp): string | null => {
      const row = screen.getByRole('button', { name });
      return row.querySelector('.eoy-row__distance')?.textContent ?? null;
    };

    // Before a fix exists there is NO distance. Anything printed here would have been
    // measured from the centre of the city, which is not where anyone is. Absent, not wrong.
    expect(distanceOf(/KATZ S DELICATESSEN/)).toBeNull();
    expect(distanceOf(/LA COLOMBE/)).toBeNull();

    await user.click(screen.getByRole('button', { name: /near me/i }));

    // Times Square is the only reference point, so this is the distance from Times Square.
    const expected = formatDistance(
      haversineMiles(TimesSquareLocation, { lat: 40.7223, lng: -73.9875 }),
    );
    await waitFor(() => {
      expect(distanceOf(/KATZ S DELICATESSEN/)).toBe(expected);
    });

    // And explicitly NOT the city-centre distance, which is what a fallback origin would
    // have produced. This is the difference the requirement is about.
    const fromCityCentre = formatDistance(
      haversineMiles(DEFAULT_VIEW, { lat: 40.7223, lng: -73.9875 }),
    );
    expect(expected).not.toBe(fromCityCentre);
  });

  it('on denial: a dismissible inline message, and everything still works', async () => {
    const user = userEvent.setup();
    const app = renderApp({ geolocation: makeGeolocation('denied') });
    await screen.findAllByText(/3 places in this area/i);

    await user.click(screen.getByRole('button', { name: /near me/i }));

    const notice = await screen.findByText(/permission was declined/i);
    expect(notice).toBeInTheDocument();
    // Non-blocking: a status region, not a dialog, and no dialog exists at all.
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(notice.closest('[role="status"]')).not.toBeNull();

    // The map did not move and no user indicator appeared.
    expect(app.controller().calls.flyTo).not.toHaveBeenCalled();
    expect(screen.queryByText(/using your location/i)).not.toBeInTheDocument();

    // Search and the list still work, which is the whole point of "non-blocking".
    await user.click(screen.getByRole('radio', { name: /^list/i }));
    expect(screen.getByRole('button', { name: /KATZ S DELICATESSEN/i })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /dismiss/i }));
    await waitFor(() => {
      expect(screen.queryByText(/permission was declined/i)).not.toBeInTheDocument();
    });
  });

  it('on unavailability: works with no geolocation at all, which is jsdom by default', async () => {
    const user = userEvent.setup();
    expect(globalThis.navigator.geolocation).toBeUndefined();

    renderApp({});
    await screen.findAllByText(/3 places in this area/i);

    await user.click(screen.getByRole('button', { name: /near me/i }));

    const notice = await screen.findByText(/will not share your location/i);
    expect(notice).toBeInTheDocument();
    expect(notice).toHaveTextContent(/browse the list/i);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getAllByText(/3 places in this area/i).length).toBeGreaterThan(0);
  });

  it('on unavailable position and on timeout: distinct, non-blocking messages', async () => {
    const user = userEvent.setup();

    const unavailable = renderApp({ geolocation: makeGeolocation('unavailable') });
    await screen.findAllByText(/3 places in this area/i);
    await user.click(screen.getByRole('button', { name: /near me/i }));
    expect(await screen.findByText(/will not share your location/i)).toBeInTheDocument();
    unavailable.unmount();

    renderApp({ geolocation: makeGeolocation('timeout') });
    await screen.findAllByText(/3 places in this area/i);
    await user.click(screen.getByRole('button', { name: /near me/i }));
    const message = await screen.findByText(/took too long/i);
    expect(message).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('never writes the visitor position into the URL', async () => {
    const user = userEvent.setup();
    // Deliberately NOT Times Square: if anything leaked, a centre-derived coordinate would
    // still show up in the query string.
    const app = renderApp({
      geolocation: makeGeolocation('granted', { lat: 40.6412, lng: -73.9441 }),
    });
    await screen.findAllByText(/3 places in this area/i);
    await user.click(screen.getByRole('button', { name: /near me/i }));
    await waitFor(() => {
      expect(screen.getByText(/using your location/i)).toBeInTheDocument();
    });

    const search = window.location.search;
    expect(search).not.toMatch(/40\.6412/);
    expect(search).not.toMatch(/73\.9441/);
    expect(search).not.toMatch(/lat=/);
    // Only the six whitelisted keys are ever written.
    for (const key of search.replace(/^\?/, '').split('&')) {
      if (key.length === 0) continue;
      expect(['lat', 'lng', 'z', 'type', 'borough', 'sel']).toContain(key.split('=')[0] ?? '');
    }
    expect(app.geocodeCalls()).toEqual([]);
  });

  it('shows a locating state while the browser is deciding', async () => {
    const user = userEvent.setup();
    let settle: (() => void) | null = null;
    const pending = new Promise<void>((resolve) => {
      settle = resolve;
    });

    const geolocation = {
      callCount: () => 1,
      getCurrentPosition: (success: PositionCallback) => {
        void pending.then(() => {
          success({
            coords: {
              latitude: TimesSquareLocation.lat,
              longitude: TimesSquareLocation.lng,
              accuracy: 5,
              altitude: null,
              altitudeAccuracy: null,
              heading: null,
              speed: null,
            },
            timestamp: 0,
          } as unknown as GeolocationPosition);
        });
      },
      watchPosition: () => 0,
      clearWatch: () => undefined,
    } as unknown as Geolocation;

    renderApp({ geolocation });
    await screen.findAllByText(/3 places in this area/i);

    await user.click(screen.getByRole('button', { name: /near me/i }));

    const button = screen.getByRole('button', { name: /locating/i });
    expect(button).toBeDisabled();

    await act(async () => {
      settle?.();
      await pending;
    });

    await waitFor(() => {
      expect(screen.getByText(/using your location/i)).toBeInTheDocument();
    });
  });
});
