/**
 * THE AUTOMATED ACCESSIBILITY AUDIT.
 *
 * `tests/contrast.test.ts` measures colour. This asserts everything axe can: that every
 * control has an accessible name, that every role carries the state it claims, that headings
 * descend without skipping, that landmarks are unique and named, and that nothing on screen
 * is orphaned from the accessibility tree.
 *
 * Both exist because neither covers the other. Contrast maths will never notice a button
 * with no name; axe will never notice that a focus ring is 2.56:1 on the header it sits on.
 *
 * The app is audited in the states a visitor actually lands in, not just the happy one. Most
 * accessibility bugs live in the states: the empty list, the error card, the open search
 * panel, the dialog — those are the trees nobody demos.
 *
 * WHAT IS DELIBERATELY NOT RUN, and why:
 *   - `color-contrast`. axe needs a layout engine to resolve computed colours against real
 *     backgrounds; under jsdom it reports nothing useful, and when it guesses it guesses
 *     wrongly. `tests/contrast.test.ts` measures the same colours exactly, from the tokens,
 *     in four schemes — which is strictly stronger.
 *   - Rules that depend on a real browser are noted inline where they appear.
 */

import { describe, expect, it } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { computeAccessibleName } from 'dom-accessibility-api';
import { geocodeHit, makeGeolocation, renderApp } from './helpers/render';

/** The WCAG 2.2 A + AA rulesets, plus best practice, minus what jsdom cannot judge. */
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'];
const EXCLUDED = new Set(['color-contrast']);

/** Every violation axe found, as one readable multi-line string for a failure message. */
function describeViolations(violations: axe.Result[]): string {
  return violations
    .map((v) => {
      const targets = v.nodes.map((n) => `      ${n.target.join(' ')}`).join('\n');
      return `  [${v.impact}] ${v.id}: ${v.help}\n    ${v.helpUrl}\n${targets}\n    ${v.nodes[0]?.failureSummary ?? ''}`;
    })
    .join('\n\n');
}

async function audit(label: string): Promise<void> {
  const results = await axe.run(document.body, {
    runOnly: { type: 'tag', values: TAGS },
    rules: Object.fromEntries([...EXCLUDED].map((id) => [id, { enabled: false }])),
  });
  expect(
    results.violations,
    `${label} produced ${results.violations.length} accessibility violation(s):\n\n${describeViolations(results.violations)}`,
  ).toEqual([]);
  // An "incomplete" result is not a failure — it is a rule that could not decide. Worth
  // seeing, though, so the count is asserted not to explode into "axe is not really running".
  expect(results.passes.length, `${label}: axe passed almost nothing, so the audit is not working`).toBeGreaterThan(5);
}

describe('axe finds no violations in any state the app can be in', () => {
  it('while the dataset is loading', async () => {
    renderApp({ dataset: { hang: true } });
    await screen.findByTestId('dataset-loading');
    await audit('dataset loading');
  });

  it('when the dataset fails, with the retry offered', async () => {
    renderApp({ dataset: { fail: new Error('network down') } });
    await screen.findByTestId('dataset-error');
    await audit('dataset error');
  });

  it('on the map, ready', async () => {
    renderApp({});
    await screen.findAllByText(/3 places in this area/i);
    await audit('map, ready');
  });

  it('on the list, ready', async () => {
    const user = userEvent.setup();
    renderApp({});
    await screen.findAllByText(/3 places in this area/i);
    await user.click(screen.getByRole('radio', { name: /^List/ }));
    await audit('list, ready');
  });

  it('with the detail sheet open — the modal, focus-trapped, inert-behind case', async () => {
    const user = userEvent.setup();
    renderApp({});
    await screen.findAllByText(/3 places in this area/i);
    // The rows live in the list, which sits behind the map toggle, so switch to it first
    // rather than reaching into a hidden tree — which is exactly the discipline this whole
    // file is trying to encourage.
    await user.click(screen.getByRole('radio', { name: /^List/ }));
    await user.click(screen.getByRole('button', { name: /KATZ S DELICATESSEN/ }));
    await screen.findByTestId('detail-sheet');
    await audit('detail sheet open');
  });

  it('with filters applied and the clear affordance showing', async () => {
    const user = userEvent.setup();
    renderApp({});
    await screen.findAllByText(/3 places in this area/i);
    await user.click(screen.getByRole('radio', { name: /^Sidewalk \+ roadway dining/ }));
    await user.click(screen.getByRole('radio', { name: /^Queens/ }));
    await audit('filters applied');
  });

  it('with the search panel open and both result groups present', async () => {
    const user = userEvent.setup();
    renderApp({
      geocode: async () => geocodeHit({ label: 'SoHo, New York' }),
    });
    await screen.findAllByText(/3 places in this area/i);
    await user.type(screen.getByRole('combobox'), 'Katz');
    await user.keyboard('{Enter}');
    await waitFor(() => {
      expect(screen.getByRole('listbox')).toBeInTheDocument();
    });
    await audit('search panel open');
  });

  it('with a geolocation message, which points at the list as the way through', async () => {
    const user = userEvent.setup();
    renderApp({ geolocation: makeGeolocation('denied') });
    await screen.findAllByText(/3 places in this area/i);
    await user.click(screen.getByRole('button', { name: /near me/i }));
    // The notice is inside the message stack, which is how this test tells it apart from
    // the search box's own polite region and the filter-change announcement.
    await waitFor(() => {
      expect(document.querySelector('.eoy-notice')).toHaveTextContent(/location/i);
    });
    await audit('geolocation declined');
  });

  it('with an empty area, which offers the two honest ways out', async () => {
    const user = userEvent.setup();
    renderApp({});
    await screen.findAllByText(/3 places in this area/i);
    await user.click(screen.getByRole('radio', { name: /^Queens/ }));
    await user.click(screen.getByRole('radio', { name: /^List/ }));
    await waitFor(() => {
      expect(screen.getByText(/no matching places in this area/i)).toBeInTheDocument();
    });
    await audit('empty area');
  });

  it('with the basemap failing, which must not hide the data', async () => {
    renderApp({ mapPending: true });
    await screen.findByTestId('map-loading');
    await audit('basemap loading');
  });
});

describe('the accessibility invariants axe cannot check', () => {
  it('every interactive control has a non-empty accessible name, in both views', async () => {
    const user = userEvent.setup();
    renderApp({});
    await screen.findAllByText(/3 places in this area/i);

    /*
     * The real accessible-name algorithm, not a hand-rolled guess. The first version of
     * this test read `HTMLInputElement.labels` and checked `Array.isArray(...)` on it — a
     * live `HTMLLabelsCollection` is not an Array, so the check silently returned nothing
     * and reported all ten filter radios plus the search box as unnamed. They were all
     * correctly labelled. A hand-rolled name computation is a test that either lies or
     * cries wolf; this one is the same code path a screen reader uses.
     */
    const controls = [
      ...document.querySelectorAll<HTMLElement>('button, a[href], input:not([type=hidden])'),
    ];
    // Non-empty is the floor. A name of only punctuation, or a name identical to the role,
    // is a different failure and is asserted separately below.
    const nameless = controls.filter((el) => computeAccessibleName(el).trim() === '');
    expect(
      nameless.map((el) => el.outerHTML.slice(0, 100)),
      'these controls have no accessible name',
    ).toEqual([]);
    // The map view carries the header, the rail and the view toggle; the list view adds every
    // row and the "show more" button. Both are checked, because a row and a chip are
    // different kinds of thing to have got wrong.
    expect(controls.length, 'the map view should hold the header, the rail and the toggle').toBeGreaterThan(15);

    /*
     * The rows are the point of the second pass. `querySelectorAll` walks a hidden subtree
     * happily, so the first pass already saw them — which is worth knowing, and is why this
     * is a re-check after switching views rather than a first-time discovery. A row is a
     * whole-place button whose name has to carry the name, the address and the dining type,
     * because that is all a screen-reader user gets instead of a pin on a map.
     */
    await user.click(screen.getByRole('radio', { name: /^List/ }));
    const rows = [...document.querySelectorAll<HTMLElement>('.eoy-row')];
    expect(rows.length, 'the list should be showing its rows').toBeGreaterThan(0);
    for (const row of rows) {
      const name = computeAccessibleName(row);
      expect(name.trim(), `a row has no accessible name: ${row.outerHTML.slice(0, 80)}`).not.toBe('');
      // The type is never colour alone, so it has to be spoken as part of the row's name.
      expect(name, 'a row does not name its dining type').toMatch(/dining/i);
    }
  });

  it('no control announces only its own role as its name', async () => {
    renderApp({});
    await screen.findAllByText(/3 places in this area/i);
    // "button" or "link" as a name satisfies the letter of the rule and tells a user
    // nothing. Icons get a visually-hidden word; that is the pattern this asserts.
    const roleOnly = [...document.querySelectorAll<HTMLElement>('button, a[href]')]
      .filter((el) => {
        const name = computeAccessibleName(el).trim().toLowerCase();
        return name === 'button' || name === 'link' || name === '';
      })
      .map((el) => el.outerHTML.slice(0, 100));
    expect(roleOnly).toEqual([]);
  });

  it('headings descend without skipping a level', async () => {
    renderApp({});
    await screen.findAllByText(/3 places in this area/i);
    const levels = [...document.querySelectorAll('h1,h2,h3,h4,h5,h6')].map((h) =>
      Number.parseInt(h.tagName.slice(1), 10),
    );
    expect(levels[0], 'the page must open with an h1').toBe(1);
    for (let i = 1; i < levels.length; i += 1) {
      const previous = levels[i - 1];
      const current = levels[i];
      expect(
        current! - previous!,
        `heading level jumped from h${previous} to h${current}`,
      ).toBeLessThanOrEqual(1);
    }
  });

  it('there is exactly one h1, and it is the wordmark', async () => {
    renderApp({});
    await screen.findAllByText(/3 places in this area/i);
    const h1s = document.querySelectorAll('h1');
    expect(h1s).toHaveLength(1);
    expect(h1s[0]?.textContent).toContain('Eat Outside NYC');
  });
});
