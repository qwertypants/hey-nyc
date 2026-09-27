/**
 * Filters: the panel, the counts, and the fact that a filter change reaches the map and the
 * list through the SAME controller call, so the three can never disagree.
 *
 * The counts under test come from `countFor` in `src/lib/filters.ts` with the OTHER dimension
 * held at its current value, which is the same predicate the map compiles into a MapLibre
 * `setFilter` expression.
 */

import { describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderApp } from './helpers/render';

const panel = (): HTMLElement => screen.getByTestId('filter-panel');

function optionCount(label: RegExp): string | null {
  const row = within(panel()).getByRole('radio', { name: label }).closest('label');
  return row?.querySelector('.eoy-filters__count')?.textContent ?? null;
}

async function openFilters(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.click(screen.getByRole('button', { name: /^Filters/ }));
  await screen.findByTestId('filter-panel');
}

describe('filters', () => {
  it('groups the two filterable dimensions in real fieldsets with legends', async () => {
    const user = userEvent.setup();
    renderApp({});
    await screen.findAllByText(/3 places in this area/i);
    await openFilters(user);

    // Real `<fieldset>` / `<legend>` grouping, not a div with a heading that happens to look
    // like one. `getByText` because jsdom exposes no `legend` role.
    const legends = [...panel().querySelectorAll('legend')].map((node) => node.textContent);
    expect(legends).toEqual(['Dining type', 'Borough']);
    for (const legend of panel().querySelectorAll('legend')) {
      expect(legend.closest('fieldset')).not.toBeNull();
    }

    // Wording comes from `describeType` in src/map/style.ts, never re-invented.
    const typeLabels = within(panel())
      .getAllByRole('radio')
      .slice(0, 4)
      .map((radio) => radio.closest('label')?.textContent ?? '');
    expect(typeLabels[0]).toMatch(/^All types/);
    expect(typeLabels[1]).toMatch(/^Sidewalk dining/);
    expect(typeLabels[2]).toMatch(/^Roadway dining/);
    expect(typeLabels[3]).toMatch(/^Sidewalk \+ roadway dining/);
  });

  it('shows a count per option, counting against the other dimension', async () => {
    const user = userEvent.setup();
    renderApp({});
    await screen.findAllByText(/3 places in this area/i);
    await openFilters(user);

    expect(optionCount(/^All types/)).toBe('8');
    expect(optionCount(/^Sidewalk dining/)).toBe('4');
    expect(optionCount(/^Roadway dining/)).toBe('2');
    expect(optionCount(/^Sidewalk \+ roadway dining/)).toBe('2');
    expect(optionCount(/^All boroughs/)).toBe('8');

    // With roadway selected, the borough counts must collapse to the roadway subset.
    await user.click(within(panel()).getByRole('radio', { name: /^Roadway dining/ }));
    expect(optionCount(/^Manhattan/)).toBe('1');
    expect(optionCount(/^Brooklyn/)).toBe('1');
    // An empty option says "none" rather than "0", which is a word rather than a number.
    expect(optionCount(/^Queens/)).toBe('none');
  });

  it('disables an option that would yield nothing, and says so instead of hiding it', async () => {
    const user = userEvent.setup();
    renderApp({});
    await screen.findAllByText(/3 places in this area/i);
    await openFilters(user);

    await user.click(within(panel()).getByRole('radio', { name: /^Roadway dining/ }));

    // roadway + Staten Island is empty in this fixture, exactly as it is in the real data
    // for most type/borough pairs.
    const statenIsland = within(panel()).getByRole('radio', { name: /^Staten Island/ });
    expect(statenIsland).toBeDisabled();
    expect(optionCount(/^Staten Island/)).toBe('none');
    expect(optionCount(/^Queens/)).toBe('none');

    // The current selection is never disabled: you must always be able to select what you
    // already have, and "All" must always be an escape.
    const all = within(panel()).getByRole('radio', { name: /^All boroughs/ });
    expect(all).toBeEnabled();
    expect(within(panel()).getByRole('radio', { name: /^Roadway dining/ })).toBeEnabled();

    await user.click(all);
    // Still roadway, so Staten Island is legitimately still empty. Widen the TYPE and it comes
    // back — which is the point: an option is only dead while the OTHER dimension excludes it.
    expect(within(panel()).getByRole('radio', { name: /^Staten Island/ })).toBeDisabled();
    await user.click(within(panel()).getByRole('radio', { name: /^All types/ }));
    await waitFor(() => {
      expect(within(panel()).getByRole('radio', { name: /^Staten Island/ })).toBeEnabled();
    });
    expect(optionCount(/^Staten Island/)).toBe('1');
  });

  it('applies a filter to the map, the list and the count in one step', async () => {
    const user = userEvent.setup();
    const app = renderApp({});
    await screen.findAllByText(/3 places in this area/i);

    await openFilters(user);
    await user.click(
      within(panel()).getByRole('radio', { name: /^Sidewalk \+ roadway dining/ }),
    );

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
    await user.click(screen.getByRole('button', { name: /done/i }));
    await user.click(screen.getByRole('radio', { name: /^List/ }));
    const list = screen.getByTestId('location-list');
    expect(within(list).getByRole('button', { name: /LA COLOMBE/ })).toBeInTheDocument();
    expect(within(list).queryByRole('button', { name: /KATZ S DELICATESSEN/ })).not.toBeInTheDocument();
  });

  it('clears both dimensions at once and reports no active filters', async () => {
    const user = userEvent.setup();
    const app = renderApp({});
    await screen.findAllByText(/3 places in this area/i);

    await openFilters(user);
    await user.click(within(panel()).getByRole('radio', { name: /^Sidewalk \+ roadway dining/ }));
    await user.click(within(panel()).getByRole('radio', { name: /^Queens/ }));
    expect(app.controller().getState().filters.borough).not.toBe('all');

    // The header button counts the active dimensions in a visible pill.
    expect(within(screen.getByRole('button', { name: /^Filters/ })).getByText('2')).toBeVisible();

    await user.click(within(panel()).getByRole('button', { name: /^Clear/ }));
    expect(app.controller().calls.setFilters).toHaveBeenLastCalledWith({
      type: 'all',
      borough: 'all',
    });
    await waitFor(() => {
      expect(app.controller().getState().filters).toEqual({ type: 'all', borough: 'all' });
    });
  });

  it('is non-modal: Escape closes it, focus returns, and Tab can leave', async () => {
    const user = userEvent.setup();
    renderApp({});
    await screen.findAllByText(/3 places in this area/i);

    const trigger = screen.getByRole('button', { name: /^Filters/ });
    await user.click(trigger);

    const heading = within(panel()).getByRole('heading', { name: 'Filters' });
    expect(heading).toHaveFocus();
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    // `aria-controls` points at a real element even while the panel is collapsed, which is
    // why the wrapper is always in the DOM and the panel itself is what mounts.
    const controls = trigger.getAttribute('aria-controls');
    expect(controls).not.toBeNull();
    // `aria-controls` names the always-present wrapper, so the reference never dangles.
    expect(document.getElementById(controls ?? '')).toBe(
      panel().closest('.eoy-filters-wrap'),
    );

    // The rest of the app is NOT inert, unlike the detail sheet.
    expect(document.querySelector('.eoy-app__body')?.hasAttribute('inert')).toBe(false);

    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByTestId('filter-panel')).not.toBeInTheDocument();
    });
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    await waitFor(() => {
      expect(trigger).toHaveFocus();
    });
  });

  it('restores the filters from the URL on load', async () => {
    const app = renderApp({ search: '?type=both&borough=Queens' });
    await waitFor(() => {
      expect(app.controller().getState().filters).toEqual({ type: 'both', borough: 'Queens' });
    });

    const user = userEvent.setup();
    await openFilters(user);
    expect(within(panel()).getByRole('radio', { name: /^Sidewalk \+ roadway dining/ })).toBeChecked();
    expect(within(panel()).getByRole('radio', { name: /^Queens/ })).toBeChecked();
    // Only the Queens "both" place exists, and it is outside the Midtown bounds.
    await user.click(screen.getByRole('button', { name: /done/i }));
    expect(screen.getAllByText(/0 places in this area/i).length).toBeGreaterThan(0);
  });
});
