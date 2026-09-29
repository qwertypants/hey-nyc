/**
 * THE WALK COMPONENTS, THROUGH AXE AND THROUGH THE HONESTY ASSERTIONS.
 *
 * Two things are under test and they are the same two things the rest of this app is built
 * around:
 *
 *   1. ACCESSIBILITY. The app has a high bar and this feature has to meet it rather than
 *      lower it: `axe` clean, a chart with a text alternative, a live region where something
 *      changes without a focus move, keyboard-reachable controls, and no meaning carried by
 *      colour alone. `tests/axe.test.tsx` is the model.
 *   2. THE HONESTY SENTENCES, in the DOM rather than in a string builder. `detail()` returning
 *      the right words is asserted in `tests/walk-detail.test.ts`; this file proves those words
 *      survive rendering, which is a different failure and a very common one.
 */

import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import type { JSX, ReactNode } from 'react';
import type { FeatureDetail } from '../src/features/registry';
import { historicalDetail, sensorDetail } from '../src/features/walk/detail';
import { walkLegend } from '../src/features/walk/legend';
import { WALK_LAYER_TOGGLES } from '../src/features/walk/legend';
import { WalkDetailBody } from '../src/features/walk/WalkDetailBody';
import { WalkLegend } from '../src/features/walk/WalkLegend';
import { WalkSortControl } from '../src/features/walk/WalkSortControl';
import { validateHistoricalPatterns, validateLatest } from '../src/data/walk/validate';
import { LATEST_RAW, PATTERNS_RAW, NOW_MS, ORIGIN, SENSOR_BUSY, SENSOR_OFFLINE, SENSOR_STALE_ZERO_BUCKET, SURVEY_RISING, SURVEY_UNSURVEYED } from './helpers/walkFixtures';

const PATTERNS = validateHistoricalPatterns(PATTERNS_RAW);
const LATEST = validateLatest(LATEST_RAW);

/**
 * The same ruleset `tests/axe.test.tsx` uses, so the bar is the same bar, and the same
 * `color-contrast` exclusion for the same reason: jsdom has no layout engine, and
 * `tests/contrast.test.ts` plus `tests/walk-style.test.ts` measure the same colours exactly
 * from the real values, in four schemes, which is strictly stronger.
 */
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'];

/**
 * Every component is rendered inside a `<main>`, because that is where the shell puts them and
 * because axe's `region` rule (a best-practice rule, not a WCAG one) requires page content to
 * sit in a landmark. Rendering a component bare into `document.body` and then disabling the
 * rule would be asserting that a component is fine in a tree the app never builds.
 */
function inMain(children: ReactNode): JSX.Element {
  return <main>{children}</main>;
}

async function audit(label: string): Promise<void> {
  const results = await axe.run(document.body, {
    runOnly: { type: 'tag', values: TAGS },
    rules: { 'color-contrast': { enabled: false } },
  });
  expect(
    results.violations,
    `${label} produced ${results.violations.length} accessibility violation(s):\n\n${results.violations
      .map((violation) => `  [${violation.impact}] ${violation.id}: ${violation.help}\n    nodes: ${JSON.stringify(violation.nodes.map((node) => node.target))}\n    ${violation.nodes[0]?.failureSummary ?? ''}`)
      .join('\n\n')}`,
  ).toEqual([]);
  // An "incomplete" result is not a failure, but a near-zero pass count means axe is not
  // actually running — which is the failure mode nobody notices.
  expect(results.passes.length, `${label}: axe passed almost nothing, so the audit is not working`).toBeGreaterThan(5);
}

function historicalSheet(): FeatureDetail {
  return historicalDetail(SURVEY_RISING.properties, PATTERNS);
}

function zeroBucketSheet(): FeatureDetail {
  return sensorDetail(
    SENSOR_STALE_ZERO_BUCKET.properties,
    LATEST.sensors.find((sensor) => sensor.id === SENSOR_STALE_ZERO_BUCKET.id) ?? null,
    NOW_MS,
  );
}

function offlineSheet(): FeatureDetail {
  return sensorDetail(
    SENSOR_OFFLINE.properties,
    LATEST.sensors.find((sensor) => sensor.id === SENSOR_OFFLINE.id) ?? null,
    NOW_MS,
  );
}

describe('the detail body is axe-clean and its facts are a description list', () => {
  it('passes axe with the series and the chart', async () => {
    render(inMain(<WalkDetailBody detail={historicalSheet()} />));
    await audit('the walk detail body');
  });

  it('passes axe with a counter sheet, which has no chart', async () => {
    render(inMain(<WalkDetailBody detail={zeroBucketSheet()} />));
    await audit('the walk detail body, counter sheet');
  });

  it('uses a <dl>, so the terms and their values are related in the accessibility tree', () => {
    render(inMain(<WalkDetailBody detail={historicalSheet()} />));
    const list = screen.getByTestId('wnyc-detail').querySelector('dl');
    expect(list).not.toBeNull();
    const terms = [...screen.getByTestId('wnyc-detail').querySelectorAll('dt')].map((node) => node.textContent);
    expect(terms).toContain('Survey date');
    expect(screen.getAllByRole('term').length).toBe(terms.length);
  });

  it('puts the headline above the facts, because it is the claim the facts qualify', () => {
    render(inMain(<WalkDetailBody detail={historicalSheet()} />));
    const headline = screen.getByTestId('wnyc-detail-headline');
    const facts = screen.getByTestId('wnyc-detail').querySelector('dl');
    expect(headline.textContent).toBe('Surveyed May 2026');
    // `compareDocumentPosition` rather than a class check: the ORDER is the design.
    expect(
      headline.compareDocumentPosition(facts as Node) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('always renders the caveat, and it is a paragraph a reader can find', () => {
    for (const detail of [historicalSheet(), zeroBucketSheet(), offlineSheet()]) {
      const { unmount } = render(inMain(<WalkDetailBody detail={detail} />));
      expect(screen.getByTestId('wnyc-detail-caveat').textContent?.length).toBeGreaterThan(40);
      unmount();
    }
  });

  it('omits the chart entirely when there is no series, rather than drawing an empty box', () => {
    render(inMain(<WalkDetailBody detail={offlineSheet()} />));
    expect(screen.queryByTestId('wnyc-chart-svg')).not.toBeInTheDocument();
  });

  it('omits the caveat element when `caveat` is null, and does not print a placeholder', () => {
    const without: FeatureDetail = { ...historicalSheet(), caveat: null };
    render(inMain(<WalkDetailBody detail={without} />));
    expect(screen.queryByTestId('wnyc-detail-caveat')).not.toBeInTheDocument();
  });
});

describe('the rendered words are the honest words', () => {
  it('a survey sheet shows the DATE next to every number it shows', () => {
    render(inMain(<WalkDetailBody detail={historicalSheet()} />));
    const body = screen.getByTestId('wnyc-detail');
    // `getAllByText` for the date: it appears in the headline, in the Survey date fact and
    // inside the change line, which is the point — the date travels with every number.
    expect(within(body).getAllByText('May 2026').length).toBeGreaterThanOrEqual(2);
    expect(within(body).getByText('13,272')).toBeInTheDocument();
    expect(body.textContent).toContain('+3,666 since May 2007 – May 2026');
  });

  it('a zero-bucket counter sheet never says "quiet" anywhere in the DOM', () => {
    render(inMain(<WalkDetailBody detail={zeroBucketSheet()} />));
    expect(screen.getByTestId('wnyc-detail').textContent ?? '').not.toMatch(/quiet/i);
  });

  it('a zero-bucket counter sheet says "No recent reading" as its activity', () => {
    render(inMain(<WalkDetailBody detail={zeroBucketSheet()} />));
    const body = screen.getByTestId('wnyc-detail');
    expect(within(body).getByText('No recent reading')).toBeInTheDocument();
  });

  it('a zero-bucket counter sheet does not print the bare percentile', () => {
    render(inMain(<WalkDetailBody detail={zeroBucketSheet()} />));
    const text = screen.getByTestId('wnyc-detail').textContent ?? '';
    expect(text).not.toMatch(/percentile/i);
    expect(text).not.toMatch(/\b50\b/);
  });

  it('an offline counter sheet says when it stopped, not how busy it is', () => {
    render(inMain(<WalkDetailBody detail={offlineSheet()} />));
    expect(screen.getByTestId('wnyc-detail-headline').textContent).toBe('Offline since June 7');
  });

  it('an unsurveyed site shows "Not measured", never a zero', () => {
    render(inMain(<WalkDetailBody detail={historicalDetail(SURVEY_UNSURVEYED.properties, PATTERNS)} />));
    const body = screen.getByTestId('wnyc-detail');
    expect(within(body).getAllByText('Not measured')).toHaveLength(4);
    expect(body.textContent).not.toMatch(/0 people/);
  });

  it('a real counter sheet does show its level, so the guard is not "never show one"', () => {
    render(inMain(<WalkDetailBody detail={sensorDetail(SENSOR_BUSY.properties, null, NOW_MS)} />));
    expect(within(screen.getByTestId('wnyc-detail')).getByText('Busy')).toBeInTheDocument();
  });
});

describe('the chart is reachable by a screen reader, not just by an eye', () => {
  it('is an image with a label that names the numbers', () => {
    render(inMain(<WalkDetailBody detail={historicalSheet()} />));
    const chart = screen.getByRole('img');
    const label = chart.getAttribute('aria-label') ?? '';
    expect(label).toContain('separate manual surveys');
    expect(label).toContain('13,272');
    expect(label).toContain('Nothing between two surveys was measured.');
  });

  it('also carries a visible caption, for a reader who has images off', () => {
    render(inMain(<WalkDetailBody detail={historicalSheet()} />));
    const caption = document.querySelector('.wnyc-chart__caption');
    expect(caption?.textContent).toMatch(/one bar each/i);
  });

  it('the title element and the figure are associated', () => {
    render(inMain(<WalkDetailBody detail={historicalSheet()} />));
    const title = document.querySelector('.wnyc-chart__title');
    expect(title?.textContent).toBe('Every manual survey at this site');
    const figure = title?.closest('figure');
    expect(figure?.getAttribute('aria-labelledby')).toBe(title?.id);
  });
});

describe('the legend is axe-clean and carries the honesty sentence inside itself', () => {
  it('passes axe', async () => {
    render(inMain(<WalkLegend legend={walkLegend(PATTERNS.source)} />));
    await audit('the walk legend');
  });

  it('renders the note, in full, without a click', () => {
    render(inMain(<WalkLegend legend={walkLegend(PATTERNS.source)} />));
    const note = document.querySelector('.wnyc-legend__note');
    expect(note?.textContent).toContain('shown only where NYC DOT measured it');
    expect(note?.textContent).toContain('not a description of foot traffic');
  });

  it('renders every swatch with its shape description in text, not only its colour', () => {
    render(inMain(<WalkLegend legend={walkLegend(PATTERNS.source)} />));
    const list = screen.getByRole('group', { name: 'Where NYC Walks' });
    const items = within(list).getAllByRole('listitem');
    expect(items).toHaveLength(9);
    for (const item of items) {
      expect(item.textContent?.length ?? 0).toBeGreaterThan(40);
    }
  });

  it('the swatch glyph itself is aria-hidden, because the words beside it carry the meaning', () => {
    render(inMain(<WalkLegend legend={walkLegend(PATTERNS.source)} />));
    const swatches = [...document.querySelectorAll('.wnyc-legend__swatch')];
    expect(swatches).toHaveLength(9);
    for (const swatch of swatches) {
      expect(swatch.getAttribute('aria-hidden')).toBe('true');
    }
  });

  it('the no-reading swatch is visibly hollow, not just a different grey', () => {
    render(inMain(<WalkLegend legend={walkLegend(PATTERNS.source)} />));
    const hollow = [...document.querySelectorAll<HTMLElement>('.wnyc-legend__swatch')].find((node) =>
      (node.style.getPropertyValue('--wnyc-swatch-hollow') ?? '') !== '1',
    );
    expect(hollow, 'no swatch is hollow').toBeDefined();
  });

  it('links to the methodology and says it opens in a new tab', () => {
    render(inMain(<WalkLegend legend={walkLegend(PATTERNS.source)} />));
    const link = screen.getByRole('link', { name: /How these counts are collected/i });
    expect(link.getAttribute('href')).toBe(PATTERNS.source);
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toContain('noopener');
    expect(link.textContent).toContain('opens in a new tab');
  });

  it('omits the link entirely rather than rendering a dead one', () => {
    render(inMain(<WalkLegend legend={walkLegend(null)} />));
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('the layer toggles are described in words, so the shell can render them generically', () => {
    expect(WALK_LAYER_TOGGLES.map((toggle) => toggle.id)).toEqual(['historical', 'sensors']);
    for (const toggle of WALK_LAYER_TOGGLES) {
      expect(toggle.label.length).toBeGreaterThan(3);
      expect(toggle.help.length).toBeGreaterThan(30);
      expect(['manual survey', 'automated counter']).toContain(toggle.program);
    }
    expect(WALK_LAYER_TOGGLES[1]?.help).toMatch(/daily batch/);
  });
});

describe('the sort control is keyboard-reachable, radiogroup-shaped, and honest about nearby', () => {
  it('passes axe with a position', async () => {
    render(inMain(<WalkSortControl sort="mostSurveyed" origin={ORIGIN} onChange={() => undefined} />));
    await audit('the walk sort control, with a position');
  });

  it('passes axe without a position', async () => {
    render(inMain(<WalkSortControl sort="mostSurveyed" origin={null} onChange={() => undefined} />));
    await audit('the walk sort control, without a position');
  });

  it('is a radio group, so arrow keys work and the relationship is announced', () => {
    render(inMain(<WalkSortControl sort="mostSurveyed" origin={ORIGIN} onChange={() => undefined} />));
    const group = screen.getByRole('radiogroup', { name: 'Order the list' });
    expect(within(group).getAllByRole('radio')).toHaveLength(3);
    expect(within(group).getByRole('radio', { name: /Busiest at the last survey/ })).toBeChecked();
  });

  it('puts each sort\'s DEFINITION in the accessible NAME, not in a tooltip', () => {
    render(inMain(<WalkSortControl sort="mostSurveyed" origin={ORIGIN} onChange={() => undefined} />));
    const radio = screen.getByRole('radio', { name: /Busiest at the last survey/ });
    expect(radio.getAttribute('aria-describedby')).toBeNull();
    expect(radio.getAttribute('aria-label')).toBeNull();
    // The definition is in the CONTROL'S OWN NAME, so a screen reader announces the claim as
    // part of the control rather than as a separate thing to go and find. The input is a
    // SIBLING of its label and is associated by `htmlFor`, so the text is read off the label.
    const label = document.querySelector(`label[for="${radio.getAttribute('id') ?? ''}"]`);
    expect(label?.textContent).toMatch(/most recent manual survey/i);
    expect(radio.getAttribute('aria-labelledby')).toBeNull();
  });

  it('says the `mostChanged` sort is absolute, on screen', () => {
    render(inMain(<WalkSortControl sort="mostSurveyed" origin={ORIGIN} onChange={() => undefined} />));
    expect(screen.getByRole('radio', { name: /largest absolute change/i })).toBeInTheDocument();
  });

  it('offers `nearby` ONLY with a position', () => {
    const withPosition = render(
      inMain(<WalkSortControl sort="mostSurveyed" origin={ORIGIN} onChange={() => undefined} />),
    );
    expect(screen.getByRole('radio', { name: /Nearest to you/ })).toBeInTheDocument();
    withPosition.unmount();

    render(inMain(<WalkSortControl sort="mostSurveyed" origin={null} onChange={() => undefined} />));
    expect(screen.queryByRole('radio', { name: /Nearest to you/ })).not.toBeInTheDocument();
  });

  it('explains WHY `nearby` is missing, in words, rather than greying out a control', () => {
    render(inMain(<WalkSortControl sort="mostSurveyed" origin={null} onChange={() => undefined} />));
    expect(screen.getByText(/does not have your position/i)).toBeInTheDocument();
    expect(screen.getByText(/never stored and never added to this page’s address/i)).toBeInTheDocument();
  });

  it('no control is disabled', () => {
    // A disabled radio invites a question the app cannot answer. Everything rendered is usable.
    render(inMain(<WalkSortControl sort="mostSurveyed" origin={null} onChange={() => undefined} />));
    for (const radio of screen.getAllByRole('radio')) {
      expect(radio).toBeEnabled();
    }
  });

  it('every control is reachable and operable from the keyboard', async () => {
    const user = userEvent.setup();
    const chosen: string[] = [];
    render(
      inMain(
        <WalkSortControl
          sort="mostSurveyed"
          origin={ORIGIN}
          onChange={(sort) => chosen.push(sort)}
        />,
      ),
    );
    // A radio group is ONE tab stop: Tab lands on the checked radio, and the ARROW keys move
    // within the group. Asserting three tab stops would be asserting the wrong thing, and
    // asserting three arrow stops is the behaviour a screen-reader user actually has.
    await user.tab();
    expect(screen.getByRole('radio', { name: /Busiest at the last survey/ })).toHaveFocus();

    await user.keyboard('{ArrowDown}');
    expect(screen.getByRole('radio', { name: /Changed the most/ })).toHaveFocus();
    expect(chosen).toEqual(['mostChanged']);

    await user.keyboard('{ArrowDown}');
    expect(screen.getByRole('radio', { name: /Nearest to you/ })).toHaveFocus();
    expect(chosen).toEqual(['mostChanged', 'nearby']);
  });

  it('a focused control has a visible indicator, painted on the label the eye can see', () => {
    // The stylesheet audit in tests/walk-stylesheet.test.ts measures the declaration; this
    // asserts the relationship is between the input and the LABEL, which is the part a
    // specificity bug would silently break.
    render(inMain(<WalkSortControl sort="mostSurveyed" origin={ORIGIN} onChange={() => undefined} />));
    const input = screen.getByRole('radio', { name: /Busiest at the last survey/ });
    const label = document.querySelector('label.wnyc-sort__label');
    expect(label?.getAttribute('for')).toBe(input.getAttribute('id'));
    expect(label?.textContent).toMatch(/Busiest at the last survey/);
  });

  it('falls back to the default sort when the shell has not chosen one', () => {
    render(inMain(<WalkSortControl sort={null} origin={ORIGIN} onChange={() => undefined} />));
    expect(screen.getByRole('radio', { name: /Busiest at the last survey/ })).toBeChecked();
  });
});
