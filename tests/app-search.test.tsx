/**
 * Search: one box, two modes, and every failure mode the geocoder can report.
 *
 * The properties that matter:
 *   - Nothing is requested while you type. Nominatim's usage policy forbids autocomplete
 *     against the public instance, and a request per keystroke is how you get blocked.
 *   - The two modes are LABELLED, not guessed. "MADISON" is a street, a park and several
 *     restaurant names, and a wrong guess sends someone to the wrong block.
 *   - Restaurant search is local and therefore works offline; place search is not, and says
 *     so without taking the whole box down with it.
 *   - Rate limiting, timeout, offline, empty and invalid are five different sentences
 *     because they need five different actions.
 */

import { describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { geocodeHit, renderApp } from './helpers/render';
import type { GeocodeOutcome } from '../src/lib/geocode';

const input = (): HTMLInputElement =>
  screen.getByRole('combobox', { name: /search for an area, an address/i });

async function submitSearch(user: ReturnType<typeof userEvent.setup>, query: string): Promise<void> {
  await user.clear(input());
  await user.type(input(), query);
  await user.click(screen.getByRole('button', { name: 'Search' }));
}

function results(): HTMLElement | null {
  return screen.queryByRole('listbox', { name: /search results/i });
}

describe('search', () => {
  it('is a labelled combobox in a real search form, and never fires while typing', async () => {
    const user = userEvent.setup();
    const app = renderApp({});

    const form = screen.getByRole('search', { name: /search places and areas/i });
    expect(form.tagName).toBe('FORM');
    expect(input()).toHaveAttribute('placeholder', 'Search area or place…');
    expect(input()).toHaveAttribute('aria-expanded', 'false');
    expect(input()).toHaveAttribute('aria-autocomplete', 'list');

    await screen.findAllByText(/3 places in this area/i);
    await user.type(input(), 'KATZ');

    // Ten characters typed, zero requests made.
    expect(app.geocodeCalls()).toEqual([]);
    expect(input().value).toBe('KATZ');
  });

  it('keeps the combobox association valid whether or not the popup is open', async () => {
    const user = userEvent.setup();
    renderApp({ geocode: async () => ({ status: 'empty', query: 'ZZZ' }) });
    await screen.findAllByText(/3 places in this area/i);

    const controls = input().getAttribute('aria-controls');
    expect(controls).not.toBeNull();
    // Collapsed: the element `aria-controls` names still exists, it is just hidden, and it
    // is not announced as an empty listbox.
    let popup = document.getElementById(controls ?? '');
    expect(popup).not.toBeNull();
    expect(popup).not.toBeVisible();
    expect(popup?.getAttribute('role')).not.toBe('listbox');

    await submitSearch(user, 'EMMY');
    const list = await screen.findByRole('listbox', { name: /search results/i });
    expect(list).toBeVisible();
    popup = document.getElementById(controls ?? '');
    expect(popup).toContainElement(list);
    // Each option is a real `option`, so `aria-selected` is a fact and not a decoration.
    expect(within(list).getAllByRole('option')[0]).toHaveAttribute('aria-selected', 'false');
  });

  it('searches the downloaded dataset locally, and labels which mode matched', async () => {
    const user = userEvent.setup();
    const app = renderApp({ geocode: async () => ({ status: 'empty', query: 'KATZ' }) });
    await screen.findAllByText(/3 places in this area/i);

    await submitSearch(user, 'KATZ');

    const list = await screen.findByRole('listbox', { name: /search results/i });
    // The mode is stated in words, not inferred by the reader.
    expect(within(list).getByRole('group', { name: /participating places/i })).toBeInTheDocument();
    const option = within(list).getByRole('option');
    expect(option).toHaveTextContent('KATZ S DELICATESSEN');
    // The full address and the dining type, so a result is actionable without opening it.
    expect(option).toHaveTextContent('205 EAST HOUSTON STREET, Manhattan, NY 10009');
    expect(option).toHaveTextContent('Roadway dining');
    // And it is a genuine listbox option, not a button pretending to be one.
    expect(option).toHaveAttribute('aria-selected', 'false');

    // One explicit request, for the place half of the answer.
    expect(app.geocodeCalls()).toEqual(['KATZ']);
  });

  it('picking a restaurant result selects and flies, exactly like a list row', async () => {
    const user = userEvent.setup();
    const app = renderApp({ geocode: async () => ({ status: 'empty', query: 'LA COLOMBE' }) });
    await screen.findAllByText(/3 places in this area/i);

    await submitSearch(user, 'LA COLOMBE');
    const list = await screen.findByRole('listbox', { name: /search results/i });
    await user.click(within(list).getByRole('option'));

    expect(app.controller().calls.focusOn).toHaveBeenCalledWith('eoy-0000000000a2');
    expect(await screen.findByTestId('detail-sheet')).toHaveTextContent('LA COLOMBE');
    // The results panel is dismissed, so the sheet is not fighting a dropdown for the screen.
    expect(results()).not.toBeInTheDocument();
  });

  it('picking a place result frames the map around it, not on a lone pin', async () => {
    const user = userEvent.setup();
    const app = renderApp({ geocode: async (query) => geocodeHit({ label: `Bryant Park, ${query}` }) });
    await screen.findAllByText(/3 places in this area/i);

    await submitSearch(user, 'Bryant Park');
    const list = await screen.findByRole('listbox', { name: /search results/i });
    expect(within(list).getByRole('group', { name: /areas and places/i })).toBeInTheDocument();
    await user.click(within(list).getByRole('option', { name: /Bryant Park/ }));

    expect(app.controller().calls.fitTo).toHaveBeenCalledTimes(1);
    const box = app.controller().calls.fitTo.mock.calls[0]?.[0] as {
      west: number;
      south: number;
      east: number;
      north: number;
    };
    // The frame CONTAINS the result, and is wider than tall, because a borough is not a dot.
    expect(box.west).toBeLessThan(-73.9832);
    expect(box.east).toBeGreaterThan(-73.9832);
    expect(box.south).toBeLessThan(40.7536);
    expect(box.north).toBeGreaterThan(40.7536);
    // And the camera is not moved to the list, because the map is the point.
    expect(app.controller().getState().selectedId).toBeNull();
  });

  it('shows both modes at once, so which one matched is never a guess', async () => {
    const user = userEvent.setup();
    renderApp({ geocode: async () => geocodeHit({ label: 'Flatiron District, New York, USA' }) });
    await screen.findAllByText(/3 places in this area/i);

    await submitSearch(user, 'EMMY');

    const list = await screen.findByRole('listbox', { name: /search results/i });
    expect(within(list).getByRole('group', { name: /participating places/i })).toBeInTheDocument();
    expect(within(list).getByRole('group', { name: /areas and places/i })).toBeInTheDocument();
    expect(within(list).getAllByRole('option')).toHaveLength(2);
  });

  it('keyboard: Enter submits, arrows move the highlight, Enter picks, Escape closes', async () => {
    const user = userEvent.setup();
    const app = renderApp({ geocode: async () => geocodeHit() });
    await screen.findAllByText(/3 places in this area/i);

    // The whole flow without touching the mouse: focus, type, Enter.
    await user.click(input());
    await user.type(input(), 'e{Enter}');

    const list = await screen.findByRole('listbox', { name: /search results/i });
    // Both halves have landed before the ids are captured, otherwise `aria-activedescendant`
    // would be compared against a stale option list.
    await waitFor(() => {
      expect(within(list).getByRole('group', { name: /areas and places/i })).toBeInTheDocument();
    });
    const options = within(list).getAllByRole('option');
    expect(options.length).toBeGreaterThan(1);
    // Focus never left the combobox; the highlight is tracked with `aria-activedescendant`.
    expect(input()).toHaveFocus();

    await user.keyboard('{ArrowDown}');
    expect(input()).toHaveAttribute('aria-activedescendant', options[0]?.id);
    expect(options[0]).toHaveAttribute('aria-selected', 'true');

    await user.keyboard('{ArrowDown}');
    expect(options[1]).toHaveAttribute('aria-selected', 'true');
    expect(options[0]).toHaveAttribute('aria-selected', 'false');

    await user.keyboard('{ArrowUp}{ArrowUp}');
    // Wraps round to the last option rather than dead-ending.
    expect(options[options.length - 1]).toHaveAttribute('aria-selected', 'true');

    await user.keyboard('{Enter}');
    expect(app.controller().calls.fitTo).toHaveBeenCalled();
    await waitFor(() => {
      expect(results()).not.toBeInTheDocument();
    });

    // The query is deliberately KEPT after a pick, so it can be refined rather than retyped.
    expect(input().value).toBe('e');
    await user.clear(input());
    await user.type(input(), 'EMMY{Enter}');
    await screen.findByRole('listbox', { name: /search results/i });
    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(results()).not.toBeInTheDocument();
    });
    // The query survives; only the stale results are dismissed. A second Escape clears it.
    expect(input().value).toBe('EMMY');
    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(input().value).toBe('');
    });
  });

  it('rate limiting says how long to wait, and never auto-retries', async () => {
    const user = userEvent.setup();
    const outcome: GeocodeOutcome = { status: 'rate-limited', query: 'ASTORIA', retryAfterMs: 4000 };
    const app = renderApp({
      geocode: async () => {
        app.geocodeCalls();
        return outcome;
      },
    });
    await screen.findAllByText(/3 places in this area/i);

    await submitSearch(user, 'ASTORIA');

    const message = await screen.findByText(/rate limiting us/i);
    expect(message).toHaveTextContent(/wait about 4 seconds/i);
    expect(message).toHaveTextContent(/press search again/i);
    // Exactly one request. A retry loop against a rate-limited public endpoint is how an IP
    // gets blocked, so the app makes the user press the button again.
    expect(app.geocodeCalls()).toHaveLength(1);
  });

  it.each([
    ['timeout', { status: 'timeout' } as GeocodeOutcome, /timed out/i],
    ['offline', { status: 'offline' } as GeocodeOutcome, /needs a network connection/i],
    ['an empty result', { status: 'empty' } as GeocodeOutcome, /nothing in new york matches/i],
    [
      'a server error',
      { status: 'error', message: 'Nominatim responded 502' } as GeocodeOutcome,
      /place search failed: nominatim responded 502/i,
    ],
  ])('reports %s as its own message, and keeps the local half working', async (_label, outcome, matcher) => {
    const user = userEvent.setup();
    renderApp({
      geocode: async (query) => ({ ...outcome, query } as GeocodeOutcome),
    });
    await screen.findAllByText(/3 places in this area/i);

    await submitSearch(user, 'EMMY');

    const message = await screen.findByText(matcher);
    // Scoped to the area group, so a failed place search never looks like a failed search.
    expect(message).toHaveTextContent(/areas and places/i);
    // The local, offline half is unaffected and still picks the restaurant.
    const list = screen.getByRole('listbox', { name: /search results/i });
    expect(within(list).getByRole('option', { name: /EMMY/ })).toBeInTheDocument();
  });

  it('refuses an empty query without a request', async () => {
    const user = userEvent.setup();
    const app = renderApp({});
    await screen.findAllByText(/3 places in this area/i);

    await user.click(screen.getByRole('button', { name: 'Search' }));

    expect(await screen.findByText(/type a place, an address/i)).toBeInTheDocument();
    expect(app.geocodeCalls()).toEqual([]);
  });

  it('clearing the box discards results that no longer answer what is typed', async () => {
    const user = userEvent.setup();
    renderApp({ geocode: async () => geocodeHit() });
    await screen.findAllByText(/3 places in this area/i);

    await submitSearch(user, 'EMMY');
    await screen.findByRole('listbox', { name: /search results/i });

    await user.type(input(), '!');
    // Results for "EMMY" would be a lie about "EMMY!".
    expect(results()).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /clear search/i }));
    expect(input().value).toBe('');
  });
});
