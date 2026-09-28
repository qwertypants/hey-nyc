/**
 * THE SKIP CONTROL — the first focusable thing on the page, and the only one that both
 * changes the view and moves focus.
 *
 * `app-map-list.test.tsx` owns the contract between the map and the list. It does not own
 * this one, and the gap was real: the list section carried `id="eoy-place-list"` and
 * nothing in the app pointed at it, and no test activated the control at all. The
 * properties here are the ones that make the control honest rather than merely present:
 *
 *   - It NAMES the region it controls, and the name resolves to a real element in the live
 *     DOM. Comparing the attribute to a string would be satisfied by a stale id, which
 *     claims a relationship the document does not have — worse than claiming none.
 *   - The region it names is the one that appears, and it is the same node before and after
 *     the press, so the control revealed the thing it named rather than a lookalike.
 *   - Its accessible name says the map goes away. "Skip to…" describes a change of focus,
 *     and a screen-reader user cannot see the map disappear.
 *   - It is not offered at all until the region it names exists, because the two real
 *     states before that — loading, failed — have no list to point at.
 */

import { describe, expect, it } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { computeAccessibleName } from 'dom-accessibility-api';
import { renderApp } from './helpers/render';

/**
 * Located by role and name rather than by class, because the association this file exists to
 * check is a name the assistive technology can read. `/list/` is deliberately the one word
 * every version of this label has carried — "Skip to the list of places", "Show the list of
 * places, not the map", "Show the list, not the map" — so a failure here is about the
 * association and not about the wording. The wording is pinned separately, and on its own
 * terms, in the name test below.
 */
function skipControl(): HTMLElement {
  return screen.getByRole('button', { name: /list/i });
}

/**
 * The element the control claims to control, or a failure that says which half of the
 * relationship broke. Returns non-null so nothing downstream has to re-check it, which is
 * also why this is not `expect(...).not.toBeNull()` — that narrows nothing for `tsc`, and
 * every call site would then need a second assertion saying the same thing.
 */
function controlledRegion(): HTMLElement {
  const id = skipControl().getAttribute('aria-controls');
  if (id === null) {
    throw new Error('the skip control carries no aria-controls, so it names no region');
  }
  const region = document.getElementById(id);
  if (region === null) {
    throw new Error(`aria-controls="${id}" matches no element in the document`);
  }
  return region;
}

describe('the skip control', () => {
  it('names the region it controls, and the name resolves to the list section', async () => {
    renderApp({});
    await screen.findAllByText(/3 places in this area/i);

    // A button, not an anchor. `<a href="#eoy-place-list">` would be the standard skip-link
    // shape and it would be wrong here: the list carries `hidden` in map view, so the
    // browser would try to focus a subtree that is not rendered, and the view underneath it
    // would still be the map. There is no router, so this is an action, not navigation.
    const control = skipControl();
    expect(control.tagName).toBe('BUTTON');
    expect(control).not.toHaveAttribute('href');

    const region = controlledRegion();
    // The same node the rest of the app addresses as the list, so the id cannot be pointing
    // at a wrapper that merely looks like one.
    expect(region).toBe(screen.getByTestId('location-list'));
    expect(region.tagName).toBe('SECTION');
    // It is a named region, which is what `aria-controls` is for: naming a region lets the
    // reader see what is behind the control before they press it. `hidden: true` because the
    // accname spec returns "" for a hidden node unless it was reached by reference — and
    // whether a hidden node is IN the accessibility tree is a separate question from what it
    // is called, which is the whole point: this region exists in map view and has a name.
    expect(computeAccessibleName(region, { hidden: true })).toMatch(/places in the current map area/i);
  });

  it('reveals the region it named, and lands focus inside it', async () => {
    const user = userEvent.setup();
    renderApp({});
    await screen.findAllByText(/3 places in this area/i);

    // Before the press: in the DOM, out of the accessibility tree. The association has to
    // resolve in BOTH views, which is why the section is mounted from the first frame.
    const region = controlledRegion();
    expect(region).toBeInTheDocument();
    expect(region).not.toBeVisible();

    await user.click(skipControl());

    // The same node, now shown — the control revealed the thing it named, not a copy.
    expect(controlledRegion()).toBe(region);
    expect(region).toBeVisible();

    // Focus lands on the region's heading, not on the section (which is not focusable) and
    // not back on the control, so a screen reader starts reading the list rather than the
    // page header the control sits in.
    const heading = within(region).getByRole('heading');
    expect(document.activeElement).toBe(heading);
    expect(heading).toHaveAttribute('tabindex', '-1');
  });

  it('says in its name that the map goes away', async () => {
    renderApp({});
    await screen.findAllByText(/3 places in this area/i);

    // Pinned to an active verb on purpose. "Skip to the list of places" is a promise about
    // focus only, and pressing this also replaces the whole stage; a screen-reader user
    // cannot see that happen, so the name has to carry it. Pinned as the two FACTS rather
    // than as wording: the label is held to one line at 320px, and pinning the exact string
    // would make that budget impossible to keep without editing a test.
    const name = computeAccessibleName(skipControl());
    expect(name).toMatch(/^show/i);
    expect(name).toMatch(/\blist\b/i);
    expect(name, 'the name does not say the map is replaced').toMatch(/not the map/i);
    // The 1.4.10 reflow floor. `.eoy-skip-link` has no width and no nowrap, so a longer label
    // wraps rather than overflowing, and a two-line pill covers the wordmark.
    expect(name.length, 'the label wraps to two lines at 320px').toBeLessThanOrEqual(30);
  });

  it('is not offered while the dataset is still loading', async () => {
    // `LocationList` is not mounted until the dataset is ready, so an offered control would
    // carry an `aria-controls` pointing at nothing — a claim the DOM denies, which axe rates
    // critical — and a name promising a list that is not there.
    renderApp({ dataset: { hang: true } });
    await screen.findByTestId('dataset-loading');
    expect(screen.queryByRole('button', { name: /list of places/i })).not.toBeInTheDocument();
  });

  it('is not offered when the dataset has failed', async () => {
    // The other real state before there is a list, and the one a visitor is most stuck in.
    renderApp({ dataset: { fail: new Error('network down') } });
    await screen.findByTestId('dataset-error');
    expect(screen.queryByRole('button', { name: /list of places/i })).not.toBeInTheDocument();
  });
});
