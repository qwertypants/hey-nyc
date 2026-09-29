/**
 * URL state: read once, written continuously, and never a source of truth it cannot recover
 * from.
 *
 * The properties that matter:
 *   - A shared link restores the map, the filters and the selection.
 *   - Writing is debounced and uses replaceState, so panning does not fill the Back button.
 *   - Malformed input degrades to the default citywide view and no filters, and the app
 *     still renders. `parseUrlState` is throw-free by construction; this proves the app
 *     survives what a user can actually paste into the address bar.
 *   - A visitor's position is never in there. Covered in tests/app-geolocation.test.tsx.
 */

import { describe, expect, it } from 'vitest';
import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderApp } from './helpers/render';
import { DEFAULT_VIEW, parseUrlState } from '../src/lib/urlState';

const DEBOUNCED = 20;

function currentSearch(): string {
  return window.location.search;
}

describe('url state', () => {
  it('starts at the citywide view with an empty query string', async () => {
    const app = renderApp({ app: { urlDelayMs: DEBOUNCED } });
    await screen.findAllByText(/3 places in this area/i);

    expect(app.controller().getState().view).toEqual(DEFAULT_VIEW);
    expect(currentSearch()).toBe('');
  });

  it('restores view, filters and selection from a shared link', async () => {
    const app = renderApp({
      search: '?lat=40.7447&lng=-73.9924&z=14&type=both&sel=eoy-0000000000a2',
      app: { urlDelayMs: DEBOUNCED },
    });

    await waitFor(() => {
      expect(app.controller().getState().view).toEqual({
        lat: 40.7447,
        lng: -73.9924,
        zoom: 14,
      });
    });
    expect(app.controller().getState().filters).toEqual({ type: 'both', borough: 'all' });
    expect(app.controller().getState().selectedId).toBe('eoy-0000000000a2');

    // The sheet opens from the link alone — nobody has to tap anything.
    const sheet = await screen.findByTestId('detail-sheet');
    expect(sheet).toHaveTextContent('LA COLOMBE');
    // And the list marks it as the current one.
    const list = screen.getByTestId('location-list');
    expect(
      list.querySelector('.eoy-row[aria-current="true"] .eoy-row__name'),
    ).toHaveTextContent('LA COLOMBE');
  });

  it('writes the camera, filters and selection back, debounced', async () => {
    const user = userEvent.setup();
    const app = renderApp({ app: { urlDelayMs: DEBOUNCED } });
    await screen.findAllByText(/3 places in this area/i);

    // A pan is reported by the map on moveend; it must land in the query string.
    act(() => {
      app.controller().setBounds(app.bounds, { lat: 40.7447, lng: -73.9924, zoom: 14.25 });
    });
    await user.click(screen.getByRole('radio', { name: /^Roadway dining/ }));
    await user.click(screen.getByRole('radio', { name: /^List/ }));
    await user.click(screen.getByRole('button', { name: /KATZ S DELICATESSEN/ }));

    // Tapping a row also flies, so the zoom in the link is the one `focusOn` chose.
    await waitFor(() => {
      expect(currentSearch()).toBe(
        '?lat=40.7447&lng=-73.9924&z=15.5&type=roadway&sel=eoy-0000000000a1',
      );
    });

    // The written query parses back to the same state: a link round-trips.
    expect(parseUrlState(currentSearch())).toEqual({
      // `mode` is omitted at its default, which is what the empty string above proves.
      mode: 'eat',
      view: { lat: 40.7447, lng: -73.9924, zoom: 15.5 },
      filters: { type: 'roadway', borough: 'all' },
      selectedId: 'eoy-0000000000a1',
    });
  });

  it('replaceState, not pushState: panning does not grow the history', async () => {
    const user = userEvent.setup();
    const app = renderApp({ app: { urlDelayMs: DEBOUNCED } });
    await screen.findAllByText(/3 places in this area/i);

    const before = window.history.length;
    for (let step = 0; step < 4; step += 1) {
      act(() => {
        app
          .controller()
          .setBounds(app.bounds, { lat: 40.7 + step / 100, lng: -73.99, zoom: 13 + step / 10 });
      });
      await user.click(document.body);
    }
    await waitFor(() => {
      expect(currentSearch()).not.toBe('');
    });
    expect(window.history.length).toBe(before);
  });

  it('clears the query string entirely when everything returns to its default', async () => {
    const user = userEvent.setup();
    const app = renderApp({
      search: '?lat=40.7447&lng=-73.9924&z=14&type=roadway&borough=Manhattan',
      app: { urlDelayMs: DEBOUNCED },
    });
    await waitFor(() => {
      expect(app.controller().getState().filters.type).toBe('roadway');
    });
    expect(currentSearch()).toContain('type=roadway');

    // The rail's own "Clear filters", which only exists while something is filtered.
    await user.click(screen.getByRole('button', { name: /clear filters/i }));

    act(() => {
      app.controller().setBounds(app.bounds, DEFAULT_VIEW);
    });

    // Defaults are omitted, so the canonical link for "the whole city, no filters" is empty.
    await waitFor(() => {
      expect(currentSearch()).toBe('');
    });
  });

  it.each([
    ['a non-numeric zoom', '?lat=40.7&lng=-73.9&z=banana'],
    ['a missing zoom', '?lat=40.7&lng=-73.9'],
    ['an out-of-range latitude', '?lat=91&lng=-73.9&z=12'],
    ['an invented dining type', '?type=pizza&borough=Atlantis'],
    ['a malformed selection id', '?sel=%3Cscript%3Ealert(1)%3C/script%3E'],
    ['an over-long value', `?z=${'9'.repeat(500)}`],
    ['a bare question mark', '?'],
    ['an unterminated percent escape', '?lat=%E0%A4%A'],
  ])('survives %s', async (_label, search) => {
    const app = renderApp({ search });
    await screen.findAllByText(/places? in this area/i);

    // Degrades to something legal rather than throwing or half-applying the link.
    expect(app.controller().getState().view).toEqual(parseUrlState(search).view);
    expect(app.controller().getState().filters).toEqual({ type: 'all', borough: 'all' });
    expect(app.controller().getState().selectedId).toBeNull();
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Eat Outside NYC');
  });

  it('does not try to select a location id that is not in the dataset', async () => {
    // A well-formed id that no longer exists: the shared link is from an older refresh.
    const app = renderApp({ search: '?sel=eoy-abcdef012345' });
    await screen.findAllByText(/3 places in this area/i);

    expect(app.controller().getState().selectedId).toBe('eoy-abcdef012345');
    // The sheet is derived from a lookup, so a missing id shows nothing rather than crashing.
    expect(screen.queryByTestId('detail-sheet')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /KATZ S DELICATESSEN/, hidden: true })).toBeTruthy();
  });
});
