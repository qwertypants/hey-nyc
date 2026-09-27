/**
 * The detail sheet: what it says, what it refuses to say, and how it behaves for a keyboard.
 *
 * The honesty assertions matter as much as the content ones. A field that is not in the
 * source (docs/data-dictionary.md §2) must be ABSENT, not greyed out — an empty slot invites
 * the reader to fill it in themselves, and on a dining licence they will fill it in wrongly.
 */

import { describe, expect, it } from 'vitest';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { makeGeolocation, renderApp } from './helpers/render';
import { METADATA_FIXTURE } from './helpers/fixtures';

const BOTH_ID = 'eoy-0000000000a2'; // LA COLOMBE — sidewalk + roadway
const ROADWAY_ID = 'eoy-0000000000a1'; // KATZ S DELICATESSEN — roadway
const SIDEWALK_ID = 'eoy-0000000000c1'; // TAVERN ON THE GREEN — sidewalk

function sheet(): HTMLElement {
  return screen.getByTestId('detail-sheet');
}

async function openSheet(id: string): Promise<void> {
  const app = renderApp({ search: `?sel=${id}` });
  await screen.findByTestId('detail-sheet');
  void app;
}

describe('detail sheet', () => {
  it('is a labelled modal dialog, and makes the rest of the app really inert', async () => {
    await openSheet(SIDEWALK_ID);

    const dialog = screen.getByRole('dialog');
    expect(dialog).toBe(sheet());
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAccessibleName('TAVERN ON THE GREEN');

    // `aria-modal` is only honest if the rest of the tree really is out of reach, so the
    // app marks it `inert` rather than merely claiming it.
    expect(document.querySelector('.eoy-app__body')?.hasAttribute('inert')).toBe(true);
    expect(document.querySelector('.eoy-app__body')?.getAttribute('inert')).toBe('');
  });

  it('shows the name, the address, and the city line', async () => {
    await openSheet(ROADWAY_ID);

    const panel = within(sheet());
    expect(panel.getByRole('heading', { level: 2, name: 'KATZ S DELICATESSEN' })).toBeVisible();
    // The registered entity name, as secondary text.
    expect(panel.getByText('KATZ S DELICATESSEN LLC')).toBeVisible();

    const address = panel.getByText('205 EAST HOUSTON STREET').closest('address');
    expect(address).not.toBeNull();
    // The source's `city` column is really a neighbourhood, and is shown as one.
    expect(address).toHaveTextContent('NEW YORK');
    expect(address).toHaveTextContent('Manhattan, NY 10009');
  });

  it('lists the dining type as a real list, with words and a shape, never colour alone', async () => {
    await openSheet(ROADWAY_ID);

    const list = within(sheet()).getByRole('list', { name: '' });
    void list;
    const items = sheet().querySelectorAll('.eoy-type-list__item');
    expect(items).toHaveLength(1);
    expect(sheet()).toHaveTextContent('Roadway dining');
    // The shape is named, not just drawn.
    expect(sheet()).toHaveTextContent(/large circle with a heavy dark rim/i);
  });

  it('lists TWO types for a place that holds both licences', async () => {
    await openSheet(BOTH_ID);

    // `both` is derived from two source rows, so one row would under-report the licences.
    expect(sheet().querySelectorAll('.eoy-type-list__item')).toHaveLength(2);
    expect(sheet()).toHaveTextContent('Sidewalk dining');
    expect(sheet()).toHaveTextContent('Roadway dining');
    expect(sheet()).toHaveTextContent(/small solid circle/i);
    expect(sheet()).toHaveTextContent(/large circle with a heavy dark rim/i);
  });

  it('carries the DOT seasonal window only where it applies', async () => {
    await openSheet(ROADWAY_ID);
    expect(sheet()).toHaveTextContent(
      'Roadway dining may operate from April 1 through November 29.',
    );
  });

  it('omits the seasonal window for a sidewalk-only licence', async () => {
    await openSheet(SIDEWALK_ID);
    expect(sheet()).toHaveTextContent('Sidewalk dining');
    expect(sheet()).not.toHaveTextContent(/April 1/);
    expect(sheet()).not.toHaveTextContent(/November 29/);
  });

  it('shows the licence dates and status, formatted from the data', async () => {
    await openSheet(ROADWAY_ID);
    expect(sheet()).toHaveTextContent('Issued Jun 12, 2026 · expires Jun 12, 2030');
    expect(sheet()).toHaveTextContent('Status: Issued');
  });

  it('states provenance from the metadata, never from a literal date', async () => {
    await openSheet(ROADWAY_ID);
    // The exact string `formatUpdatedAt` produces for `metadata.retrievedAt`.
    // Exactly `formatUpdatedAt(metadata)` for `retrievedAt: 2026-09-27T10:15:00.000Z`.
    // The date lives in metadata.json; the sheet contains no literal of its own.
    expect(sheet()).toHaveTextContent(
      'NYC Dining Out data · Data updated Sep 27, 2026, 10:15 AM UTC',
    );
    expect(METADATA_FIXTURE.retrievedAt).toBe('2026-09-27T10:15:00.000Z');
    // The credit the dataset demands, in text.
    expect(sheet()).toHaveTextContent(/NYC Open Data/);
    expect(sheet()).toHaveTextContent(/NYC Department of Transportation/);
  });

  it('prints nothing the dataset does not contain', async () => {
    await openSheet(BOTH_ID);
    const text = sheet().textContent ?? '';

    // docs/data-dictionary.md §2: none of these fields exist. Not blank, not "coming soon".
    for (const forbidden of [
      /open now/i,
      /currently open/i,
      /closed/i,
      /opening hours|hours of|business hours/i,
      /\bmon\b|\btue\b|\bwed\b|\bthu\b|\bfri\b|\bsat\b|\bsun\b/i,
      /\brating/i,
      /\breview/i,
      /\bstars?\b/i,
      /\bprice\b|price range|\bcost\b/i,
      /cuisine/i,
      /\bmenu\b/i,
      /\bphone\b/i,
      /\bcall\b/i,
      /\bseating\b/i,
      /\bwheelchair\b/i,
      /\bbook\b|reservation/i,
      /\bfavourite|\bfavorite|\bsave\b/i,
    ]) {
      expect(text).not.toMatch(forbidden);
    }
  });

  it('hides the distance until there is a real position, then shows it', async () => {
    const user = userEvent.setup();
    // One render, two assertions: a second `renderApp` here would leave two apps mounted and
    // every `screen` query ambiguous.
    renderApp({ search: `?sel=${ROADWAY_ID}`, geolocation: makeGeolocation('granted') });
    await screen.findByTestId('detail-sheet');

    // No fix yet, so no distance. There is no city-centre fallback to print instead.
    expect(sheet()).not.toHaveTextContent(/from you/i);

    await user.click(screen.getByRole('button', { name: /near me/i }));
    await waitFor(() => {
      expect(sheet()).toHaveTextContent(/from you/i);
    });
  });

  it('closes on Escape and puts focus back where it came from', async () => {
    const user = userEvent.setup();
    const app = renderApp({});
    await screen.findAllByText(/3 places in this area/i);
    await user.click(screen.getByRole('radio', { name: /^List/ }));

    const row = within(screen.getByTestId('location-list')).getByRole('button', {
      name: /LA COLOMBE/,
    });
    await user.click(row);
    await screen.findByTestId('detail-sheet');

    // Focus went INTO the sheet, on the close button, so a keyboard user's next Tab or
    // Escape does something predictable.
    await waitFor(() => {
      expect(
        within(sheet()).getByRole('button', { name: /close details for la colombe/i }),
      ).toHaveFocus();
    });

    await user.keyboard('{Escape}');

    await waitFor(() => {
      expect(screen.queryByTestId('detail-sheet')).not.toBeInTheDocument();
    });
    // And back out again, so the list can be used straight away.
    await waitFor(() => {
      expect(row).toHaveFocus();
    });
    expect(app.controller().getState().selectedId).toBeNull();
    expect(document.querySelector('.eoy-app__body')?.hasAttribute('inert')).toBe(false);
  });

  it('closes on the close button, and the map selection is cleared with it', async () => {
    const user = userEvent.setup();
    const app = renderApp({ search: `?sel=${BOTH_ID}` });
    await screen.findByTestId('detail-sheet');

    await user.click(within(sheet()).getByRole('button', { name: /close details/i }));

    await waitFor(() => {
      expect(screen.queryByTestId('detail-sheet')).not.toBeInTheDocument();
    });
    expect(app.controller().getState().selectedId).toBeNull();
  });

  it('traps Tab inside the sheet, so focus cannot walk into the inert background', async () => {
    const user = userEvent.setup();
    renderApp({ search: `?sel=${BOTH_ID}` });
    await screen.findByTestId('detail-sheet');

    const focusable = within(sheet()).getAllByRole('button').concat(
      within(sheet()).getAllByRole('link'),
    );
    expect(focusable.length).toBeGreaterThan(1);

    // `useFocusTrap` already put focus on the close button when the sheet opened.
    expect(within(sheet()).getByRole('button', { name: /close details/i })).toHaveFocus();

    // Forward past the end wraps to the first control, and back past the start wraps to the
    // last. Focus is never outside the dialog.
    for (let step = 0; step < focusable.length + 2; step += 1) {
      await user.tab();
      expect(sheet()).toContainElement(document.activeElement as HTMLElement);
    }
    await user.tab({ shift: true });
    expect(sheet()).toContainElement(document.activeElement as HTMLElement);
  });

  it('offers "Show on map" from the list, and the map is still the default view', async () => {
    const user = userEvent.setup();
    renderApp({});
    await screen.findAllByText(/3 places in this area/i);
    await user.click(screen.getByRole('radio', { name: /^List/ }));
    await user.click(
      within(screen.getByTestId('location-list')).getByRole('button', { name: /KATZ/ }),
    );
    await screen.findByTestId('detail-sheet');

    expect(screen.getByTestId('location-list')).toBeVisible();
    await user.click(within(sheet()).getByRole('button', { name: /show on map/i }));

    expect(screen.getByTestId('map-canvas')).toBeVisible();
    // The sheet stays open: switching views must not throw away what you were reading.
    expect(screen.getByTestId('detail-sheet')).toBeInTheDocument();
  });

  it('opens from a map click and from a shared link alike', async () => {
    const user = userEvent.setup();
    const app = renderApp({});
    await screen.findAllByText(/3 places in this area/i);

    act(() => {
      app.controller().selectFromMap(ROADWAY_ID);
    });
    expect(await screen.findByTestId('detail-sheet')).toHaveTextContent('KATZ S DELICATESSEN');
    void user;
  });
});
