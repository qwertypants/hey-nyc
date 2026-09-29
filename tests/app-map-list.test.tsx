/**
 * Map / list synchronisation and selection, in both directions.
 *
 * The contract under test:
 *   - The list is whatever is inside the CURRENT MAP BOUNDS, filtered. It follows a pan.
 *   - A LIST row calls `focusOn` — selects AND flies.
 *   - A MAP click calls `setSelectedId` — highlights only, no camera move.
 *   - `bounds === null` means "not reported yet", not "nothing is visible".
 *   - The empty state is real: it says what is empty and offers a way out of it.
 *   - The row cap bounds the initial paint, never the reach.
 */

import { describe, expect, it } from 'vitest';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderApp } from './helpers/render';
import type { MapBounds } from '../src/lib/bounds';
import type { FixtureSpec } from './helpers/fixtures';
import { makeCollection } from './helpers/fixtures';

const DOWNTOWN: MapBounds = { west: -74.03, south: 40.6, east: -73.9, north: 40.85 };
const OPEN_WATER: MapBounds = { west: -74.3, south: 40.3, east: -74.2, north: 40.4 };

const ALL_PLACES =
  /KATZ|LA COLOMBE|TAVERN|EMMY|SUNSET PARK DINER|FLUSHING PALACE|BRONX COFFEE|STATEN ISLAND GRILL/;

function rowNames(): string[] {
  return within(screen.getByTestId('location-list'))
    .getAllByRole('button')
    .map((button) => button.querySelector('.eoy-row__name')?.textContent ?? '')
    .filter((name) => ALL_PLACES.test(name));
}

describe('map and list', () => {
  it('opens on the map, with the list hidden but counted', async () => {
    renderApp({});
    await screen.findAllByText(/3 places in this area/i);

    expect(screen.getByTestId('map-canvas')).toBeVisible();
    expect(screen.getByTestId('location-list')).not.toBeVisible();
    expect(screen.getByRole('radio', { name: /^Map/ })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('radio', { name: /^List/ })).toHaveAttribute('aria-checked', 'false');
    // The count is available from the map view too, so a keyboard user who never switches to
    // the list still learns how much is on screen.
    expect(screen.getByRole('radio', { name: /List/ })).toHaveTextContent(/3 places available/);
  });

  it('switches views, resizes the map, and never rebuilds it', async () => {
    const user = userEvent.setup();
    const app = renderApp({});
    await screen.findAllByText(/3 places in this area/i);

    const resizesBefore = app.controller().calls.resize.mock.calls.length;

    await user.click(screen.getByRole('radio', { name: /^List/ }));
    expect(screen.getByTestId('location-list')).toBeVisible();
    expect(screen.getByTestId('map-canvas')).not.toBeVisible();
    // A container that goes display:none must be told to re-measure, or the tiles come back
    // at the wrong size.
    expect(app.controller().calls.resize.mock.calls.length).toBeGreaterThan(resizesBefore);

    // The list is not remounted by a view switch, so its DOM (and scroll position) survive.
    expect(rowNames()).toEqual(['KATZ S DELICATESSEN', 'LA COLOMBE', 'TAVERN ON THE GREEN']);

    await user.click(screen.getByRole('radio', { name: /^Map/ }));
    expect(screen.getByTestId('map-canvas')).toBeVisible();
    expect(app.controller().calls.destroy).not.toHaveBeenCalled();
  });

  it('the list follows the map bounds, not the other way round', async () => {
    const user = userEvent.setup();
    const app = renderApp({});
    await screen.findAllByText(/3 places in this area/i);
    await user.click(screen.getByRole('radio', { name: /^List/ }));

    expect(rowNames()).toEqual(['KATZ S DELICATESSEN', 'LA COLOMBE', 'TAVERN ON THE GREEN']);

    act(() => {
      // Reported exactly as `attachMapInteractions` reports it after a pan.
      app.controller().setBounds(DOWNTOWN, { lat: 40.68, lng: -73.98, zoom: 12 });
    });

    await waitFor(() => {
      expect(screen.getAllByText(/6 places in this area/i).length).toBeGreaterThan(0);
    });
    expect(rowNames()).toEqual([
      'BRONX COFFEE',
      'EMMY',
      'KATZ S DELICATESSEN',
      'LA COLOMBE',
      'SUNSET PARK DINER',
      'TAVERN ON THE GREEN',
    ]);
  });

  it('shows the whole area, not a silent first page, and offers the rest', async () => {
    const user = userEvent.setup();
    // 140 places inside the Midtown box: more than one render page, far fewer than 2 000.
    const many: FixtureSpec[] = Array.from({ length: 140 }, (_, index) => ({
      id: `eoy-00000000${String(index).padStart(4, '0')}`,
      name: `PLACE ${String(index).padStart(3, '0')}`,
      street: `${100 + index} TEST STREET`,
      neighborhood: 'NEW YORK',
      borough: 'Manhattan' as const,
      zip: '10001',
      type: 'sidewalk' as const,
      coords: { lat: 40.7 + index / 10_000, lng: -74.0 + index / 10_000 },
    }));
    renderApp({ dataset: { collection: makeCollection(many) } });

    await screen.findAllByText(/140 places in this area/i);
    await user.click(screen.getByRole('radio', { name: /^List/ }));

    const list = screen.getByTestId('location-list');
    const rows = (): HTMLElement[] =>
      within(list).getAllByRole('button', { name: /PLACE \d{3}/ });
    const more = (): HTMLElement =>
      within(list).getByRole('button', { name: /show \d+ more/i });

    expect(rows()).toHaveLength(60);
    // The cap is stated out loud, so a bounded first paint is never mistaken for the truth.
    expect(more()).toHaveTextContent(/80 places in this area are not shown yet/);

    await user.click(more());
    await waitFor(() => expect(rows()).toHaveLength(120));
    expect(more()).toHaveTextContent(/20 places in this area are not shown yet/);

    await user.click(more());
    await waitFor(() => expect(rows()).toHaveLength(140));
    // The last page is honest about being the last one.
    expect(within(list).queryByRole('button', { name: /show .* more/i })).not.toBeInTheDocument();
    expect(within(list).getByRole('heading')).toHaveTextContent('140 places in this area');
  });

  it('selecting a list row calls focusOn — selects AND flies — and opens the sheet', async () => {
    const user = userEvent.setup();
    const app = renderApp({});
    await screen.findAllByText(/3 places in this area/i);
    await user.click(screen.getByRole('radio', { name: /^List/ }));

    await user.click(screen.getByRole('button', { name: /LA COLOMBE/ }));

    // The controller takes the POSITION as well as the id, because it has no dataset and the
    // active feature is the only thing that can turn an id into a place. Asserting both is
    // stronger than the id alone: it also proves the feature resolved the id to the right
    // coordinates, and that a row for an id the feature does not have would be refused.
    expect(app.controller().calls.focusOn).toHaveBeenCalledWith('eoy-0000000000a2', {
      lat: 40.7447,
      lng: -73.9924,
    });
    // The map really moved, to a zoom where clusters have dissolved and labels are on.
    expect(app.controller().calls.flyTo).toHaveBeenCalled();
    expect(app.controller().getState().view.zoom).toBe(15.5);
    expect(app.controller().getState().selectedId).toBe('eoy-0000000000a2');

    const sheet = await screen.findByTestId('detail-sheet');
    expect(within(sheet).getByRole('heading', { name: 'LA COLOMBE' })).toBeInTheDocument();

    // Selection is represented in the accessible DOM, not only as a ring on the map.
    const list = screen.getByTestId('location-list');
    expect(within(list).getByRole('button', { name: /LA COLOMBE/ })).toHaveAttribute(
      'aria-current',
      'true',
    );
    expect(within(list).getByRole('button', { name: /KATZ S DELICATESSEN/ })).toHaveAttribute(
      'aria-current',
      'false',
    );
  });

  it('a map click calls setSelectedId only — highlighting must not move the camera', async () => {
    const app = renderApp({});
    await screen.findAllByText(/3 places in this area/i);

    act(() => {
      app.controller().selectFromMap('eoy-0000000000a1');
    });

    await waitFor(() => {
      expect(app.controller().getState().selectedId).toBe('eoy-0000000000a1');
    });
    expect(app.controller().calls.setSelectedId).toHaveBeenCalledWith('eoy-0000000000a1');
    expect(app.controller().calls.focusOn).not.toHaveBeenCalled();
    expect(app.controller().calls.flyTo).not.toHaveBeenCalled();

    // The sheet opens from the map too, and the list marks the row.
    const sheet = await screen.findByTestId('detail-sheet');
    expect(within(sheet).getByRole('heading', { name: 'KATZ S DELICATESSEN' })).toBeInTheDocument();
  });

  it('a real empty area gets a real empty state with a way out', async () => {
    const user = userEvent.setup();
    const app = renderApp({});
    await screen.findAllByText(/3 places in this area/i);
    await user.click(screen.getByRole('radio', { name: /^List/ }));

    act(() => {
      app.controller().setBounds(OPEN_WATER);
    });

    await waitFor(() => {
      expect(screen.getByText(/no places in this area/i)).toBeInTheDocument();
    });
    expect(
      within(screen.getByTestId('location-list')).queryByRole('button', { name: /KATZ/ }),
    ).not.toBeInTheDocument();
    expect(screen.getAllByText(/0 places in this area/i).length).toBeGreaterThan(0);

    // The escape hatch is the map's own "frame everything that matches".
    await user.click(screen.getByRole('button', { name: /zoom to all 8 places/i }));
    expect(app.controller().calls.fitToResults).toHaveBeenCalled();
  });

  it('a filter that matches nothing in view says so, and offers to drop the filter', async () => {
    const user = userEvent.setup();
    const app = renderApp({});
    await screen.findAllByText(/3 places in this area/i);

    // Queens has one participating place, and it is 8 km east of the Midtown box. The rail
    // is always visible, so this is one tap rather than open-then-select-then-done.
    await user.click(screen.getByRole('radio', { name: /^Queens/ }));
    await user.click(screen.getByRole('radio', { name: /^List/ }));

    await waitFor(() => {
      expect(screen.getByText(/no matching places in this area/i)).toBeInTheDocument();
    });
    expect(screen.getByText(/do match these filters, they are just not in the part of the map/i))
      .toBeInTheDocument();
    // The dataset is NOT empty, so the offer is to re-frame the map, and to drop the filter.
    expect(screen.getByRole('button', { name: /zoom to all 1 place/i })).toBeInTheDocument();

    // Scoped to the empty state: the rail carries a "Clear filters" of its own, and two
    // buttons with one name is why this one is addressed by its region rather than globally.
    const emptyState = screen.getByRole('heading', { name: /no matching places in this area/i })
      .closest('.eoy-card');
    expect(emptyState).not.toBeNull();
    await user.click(within(emptyState as HTMLElement).getByRole('button', { name: /clear filters/i }));
    expect(app.controller().calls.setFilters).toHaveBeenLastCalledWith({
      type: 'all',
      borough: 'all',
    });
    await waitFor(() => {
      expect(screen.getAllByText(/3 places in this area/i).length).toBeGreaterThan(0);
    });
  });

  it('treats an unreported extent as "no bounds filter", not as "nothing is visible"', async () => {
    const app = renderApp({ mapPending: true });
    await screen.findByTestId('map-loading');
    // The controller has not reported bounds yet. Saying "0 places in this area" here would
    // be a lie about the map, so the list falls back to the whole (filtered) dataset.
    await waitFor(() => {
      expect(screen.getAllByText(/8 places in this area/i).length).toBeGreaterThan(0);
    });
    // The style has not loaded, so the map has genuinely never reported an extent.
    expect(app.controller().getState().bounds).toBeNull();
  });
  it('the view toggle is a real radiogroup: one tab stop, and arrow keys move the selection', async () => {
    const user = userEvent.setup();
    const app = renderApp({});
    await screen.findAllByText(/3 places in this area/i);

    const group = screen.getByRole('radiogroup', { name: /map or list view/i });
    const map = within(group).getByRole('radio', { name: /^Map/ });
    const list = within(group).getByRole('radio', { name: /^List/ });

    // Roving tabindex: the pair is ONE tab stop, which is what "radiogroup" means. Two tab
    // stops would make Tab do what the arrow keys are for.
    expect(map).toHaveAttribute('tabindex', '0');
    expect(list).toHaveAttribute('tabindex', '-1');

    // Arrow keys move the selection. This is the WAI-ARIA pattern, and it is implemented
    // here because `role="radio"` on a <button> opts out of native radio behaviour: without
    // the handler the group announced as a radiogroup and behaved like two loose buttons,
    // which is worse than either. See ViewToggle in src/components/LocationList.tsx.
    map.focus();
    await user.keyboard('{ArrowRight}');
    expect(list).toBeChecked();
    expect(list).toHaveFocus();
    expect(app.controller().getState().view).toBeDefined();

    // And they wrap, so a two-item group is not a dead end in either direction.
    await user.keyboard('{ArrowRight}');
    expect(map).toBeChecked();
    await user.keyboard('{ArrowLeft}');
    expect(list).toBeChecked();
    expect(screen.getByTestId('location-list')).not.toHaveAttribute('hidden');
  });
});
