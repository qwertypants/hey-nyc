/**
 * Filters: the rail, the counts, and the fact that a filter change reaches the map and the
 * list through the SAME controller call, so the three can never disagree.
 *
 * The counts under test come from `countFor` in `src/lib/filters.ts` with the OTHER dimension
 * held at its current value, which is the same predicate the map compiles into a MapLibre
 * `setFilter` expression.
 *
 * These used to drive a popover behind a "Filters" button. They now drive the rail, which is
 * always on screen. The guarantees below are unchanged — real fieldsets, real radios, honest
 * per-option counts, empty options disabled rather than hidden, one controller call per
 * change, a way back to "no filters" — plus three that only became possible when the
 * disclosure went away: no `aria-expanded` to get out of sync, nothing to Escape out of, and
 * a filter is one tap rather than three.
 */

import { describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderApp } from './helpers/render';

const rail = (): HTMLElement => screen.getByTestId('filter-rail');

/** The `<fieldset>` whose `<legend>` is `name`, so the two "All" chips stay addressable. */
function group(name: 'Dining type' | 'Borough'): HTMLElement {
  const legend = within(rail()).getByText(name, { selector: 'legend' });
  const fieldset = legend.closest('fieldset');
  expect(fieldset, `no <fieldset> for the "${name}" legend`).not.toBeNull();
  return fieldset as HTMLElement;
}

const types = (): HTMLElement => group('Dining type');
const boroughs = (): HTMLElement => group('Borough');

/** The visible count on a chip: a number, or the word "none". */
function chipCount(scope: HTMLElement, label: RegExp): string | null {
  const chip = within(scope).getByRole('radio', { name: label }).closest('label');
  return chip?.querySelector('.eoy-chip__count')?.textContent ?? null;
}

describe('filters', () => {
  it('is on screen with no disclosure to open, grouped in real fieldsets with legends', async () => {
    renderApp({});
    await screen.findAllByText(/3 places in this area/i);

    // There is no "Filters" button any more. The control is simply there from the first
    // frame, so it cannot be hidden behind a control the visitor has to know exists.
    expect(screen.queryByRole('button', { name: /^Filters/ })).not.toBeInTheDocument();

    const legends = [...rail().querySelectorAll('legend')].map((node) => node.textContent);
    expect(legends).toEqual(['Dining type', 'Borough']);
    for (const legend of rail().querySelectorAll('legend')) {
      expect(legend.closest('fieldset')).not.toBeNull();
    }

    // Wording comes from `describeType` in src/map/style.ts, never re-invented.
    expect(
      within(types())
        .getAllByRole('radio')
        .map((radio) => radio.closest('label')?.querySelector('.eoy-chip__label')?.textContent),
    ).toEqual(['All', 'Sidewalk dining', 'Roadway dining', 'Sidewalk + roadway dining']);

    expect(
      within(boroughs())
        .getAllByRole('radio')
        .map((radio) => radio.closest('label')?.querySelector('.eoy-chip__label')?.textContent),
    ).toEqual(['All', 'Manhattan', 'Brooklyn', 'Queens', 'Bronx', 'Staten Island']);
  });

  it('shows a count per option, counting against the other dimension', async () => {
    const user = userEvent.setup();
    renderApp({});
    await screen.findAllByText(/3 places in this area/i);

    expect(chipCount(types(), /^All\b/)).toBe('8');
    expect(chipCount(types(), /^Sidewalk dining/)).toBe('4');
    expect(chipCount(types(), /^Roadway dining/)).toBe('2');
    expect(chipCount(types(), /^Sidewalk \+ roadway dining/)).toBe('2');
    expect(chipCount(boroughs(), /^All\b/)).toBe('8');

    // With roadway selected, the borough counts must collapse to the roadway subset.
    await user.click(within(types()).getByRole('radio', { name: /^Roadway dining/ }));
    expect(chipCount(boroughs(), /^Manhattan/)).toBe('1');
    expect(chipCount(boroughs(), /^Brooklyn/)).toBe('1');
    // An empty option says "none" rather than "0", which is a word rather than a number.
    expect(chipCount(boroughs(), /^Queens/)).toBe('none');
  });

  it('carries the count in the accessible name too, and says "no places" rather than "none"', async () => {
    const user = userEvent.setup();
    renderApp({});
    await screen.findAllByText(/3 places in this area/i);

    // The count is a datum, not decoration, so a screen reader hears it too.
    expect(within(types()).getByRole('radio', { name: /^Roadway dining — 2 places$/ })).toBeVisible();

    await user.click(within(types()).getByRole('radio', { name: /^Roadway dining/ }));
    expect(within(boroughs()).getByRole('radio', { name: /^Queens — no places match$/ })).toBeVisible();
  });

  it('disables an option that would yield nothing, and says so instead of hiding it', async () => {
    const user = userEvent.setup();
    renderApp({});
    await screen.findAllByText(/3 places in this area/i);

    await user.click(within(types()).getByRole('radio', { name: /^Roadway dining/ }));

    // roadway + Staten Island is empty in this fixture, exactly as it is in the real data
    // for most type/borough pairs.
    expect(within(boroughs()).getByRole('radio', { name: /^Staten Island/ })).toBeDisabled();
    expect(chipCount(boroughs(), /^Staten Island/)).toBe('none');
    expect(chipCount(boroughs(), /^Queens/)).toBe('none');

    // The current selection is never disabled: you must always be able to select what you
    // already have, and "All" must always be an escape.
    const all = within(boroughs()).getByRole('radio', { name: /^All\b/ });
    expect(all).toBeEnabled();
    expect(within(types()).getByRole('radio', { name: /^Roadway dining/ })).toBeEnabled();

    await user.click(all);
    // Still roadway, so Staten Island is legitimately still empty. Widen the TYPE and it comes
    // back — which is the point: an option is only dead while the OTHER dimension excludes it.
    expect(within(boroughs()).getByRole('radio', { name: /^Staten Island/ })).toBeDisabled();
    await user.click(within(types()).getByRole('radio', { name: /^All\b/ }));
    await waitFor(() => {
      expect(within(boroughs()).getByRole('radio', { name: /^Staten Island/ })).toBeEnabled();
    });
    expect(chipCount(boroughs(), /^Staten Island/)).toBe('1');
  });

  it('applies a filter to the map, the list and the count in one step', async () => {
    const user = userEvent.setup();
    const app = renderApp({});
    await screen.findAllByText(/3 places in this area/i);

    await user.click(within(types()).getByRole('radio', { name: /^Sidewalk \+ roadway dining/ }));

    // One call, one source of truth. The map filters via `setFilters`; the list and the
    // count read the controller's published state back.
    expect(app.controller().calls.setFilters).toHaveBeenCalledWith({
      type: 'both',
      borough: 'all',
    });
    expect(app.controller().getState().filters).toEqual({ type: 'both', borough: 'all' });

    // TAVERN is sidewalk, KATZ is roadway, LA COLOMBE and PARSLEY-style places are both.
    await waitFor(() => {
      expect(screen.getAllByText(/1 place in this area/i).length).toBeGreaterThan(0);
    });
    await user.click(screen.getByRole('radio', { name: /^List/ }));
    const list = screen.getByTestId('location-list');
    expect(within(list).getByRole('button', { name: /LA COLOMBE/ })).toBeInTheDocument();
    expect(within(list).queryByRole('button', { name: /KATZ S DELICATESSEN/ })).not.toBeInTheDocument();
  });

  it('announces the new result count, because a filter changes two lists and neither is focused', async () => {
    const user = userEvent.setup();
    renderApp({});
    await screen.findAllByText(/3 places in this area/i);

    // Nothing is focused after a chip is chosen, so without a status message a screen reader
    // user gets no confirmation that the map and the list changed. WCAG 4.1.3.
    const status = screen.getByTestId('filter-notice');
    expect(status).toHaveAttribute('aria-live', 'polite');
    await user.click(within(types()).getByRole('radio', { name: /^Roadway dining/ }));
    await waitFor(() => {
      expect(status).toHaveTextContent('2 places match your filters across New York City.');
    });
  });

  it('clears both dimensions at once, and the way out only exists while something is filtered', async () => {
    const user = userEvent.setup();
    const app = renderApp({});
    await screen.findAllByText(/3 places in this area/i);

    // Nothing to clear, so nothing to clear it with.
    expect(screen.queryByRole('button', { name: /clear filters/i })).not.toBeInTheDocument();

    await user.click(within(types()).getByRole('radio', { name: /^Sidewalk \+ roadway dining/ }));
    await user.click(within(boroughs()).getByRole('radio', { name: /^Queens/ }));
    expect(app.controller().getState().filters.borough).not.toBe('all');

    // The selection is visible, not just counted: each group has exactly one inverted chip.
    expect(within(types()).getByRole('radio', { name: /^Sidewalk \+ roadway dining/ })).toBeChecked();
    expect(within(boroughs()).getByRole('radio', { name: /^Queens/ })).toBeChecked();

    await user.click(screen.getByRole('button', { name: /clear filters/i }));
    expect(app.controller().calls.setFilters).toHaveBeenLastCalledWith({
      type: 'all',
      borough: 'all',
    });
    await waitFor(() => {
      expect(app.controller().getState().filters).toEqual({ type: 'all', borough: 'all' });
    });
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /clear filters/i })).not.toBeInTheDocument();
    });
  });

  it('is not a dialog: nothing is trapped, and the app is never inert', async () => {
    const user = userEvent.setup();
    renderApp({});
    await screen.findAllByText(/3 places in this area/i);

    // The list is the accessible alternative to the map, so filtering must never seal it off
    // the way the detail sheet legitimately does.
    expect(document.querySelector('.eoy-app__body')?.hasAttribute('inert')).toBe(false);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    // No disclosure, so there is no `aria-expanded` that can drift out of sync with the DOM.
    expect(screen.queryByRole('button', { expanded: true })).not.toBeInTheDocument();

    // Arrow keys move within a group, because these are real radios in a real fieldset and
    // the browser gives that for free. Tab moves between groups.
    const roadway = within(types()).getByRole('radio', { name: /^Roadway dining/ });
    roadway.focus();
    await user.keyboard('{ArrowRight}');
    expect(within(types()).getByRole('radio', { name: /^Sidewalk \+ roadway dining/ })).toBeChecked();
    await user.keyboard('{ArrowLeft}');
    expect(roadway).toBeChecked();
  });

  it('restores the filters from the URL on load', async () => {
    renderApp({ search: '?type=both&borough=Queens' });
    await waitFor(() => {
      expect(screen.getByTestId('filter-rail')).toBeInTheDocument();
    });

    // Restored state is shown in the rail, so a shared link explains itself on arrival.
    await waitFor(() => {
      expect(within(types()).getByRole('radio', { name: /^Sidewalk \+ roadway dining/ })).toBeChecked();
    });
    expect(within(boroughs()).getByRole('radio', { name: /^Queens/ })).toBeChecked();
    // Only the Queens "both" place exists, and it is outside the Midtown bounds.
    await waitFor(() => {
      expect(screen.getAllByText(/0 places in this area/i).length).toBeGreaterThan(0);
    });
  });
});
