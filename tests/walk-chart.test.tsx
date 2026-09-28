/**
 * THE DISCRETE CHART.
 *
 * The hard requirement this file exists to enforce: these are 26 to 37 separate manual
 * surveys, and the chart must never draw a shape between two of them that DOT did not measure.
 *
 * The assertion is not "the connector is dashed". It is that there is NO CONNECTOR: the
 * rendered SVG contains one `<rect>` per measured survey, exactly one `<line>` (the axis), and
 * no `<path>`, `<polyline>` or `<polyline>`-shaped element of any kind. That is a property of
 * the code, not a styling decision, so a future change cannot reverse it by editing a
 * `stroke-dasharray`. To interpolate somebody would have to ADD an element, and these tests
 * fail when one appears.
 */

import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { FeatureSeries } from '../src/features/registry';
import { WalkSeriesChart } from '../src/features/walk/WalkSeriesChart';
import { buildSurveyBars, chartTextAlternative, countSurveys } from '../src/features/walk/chart';
import { CHART_GEOMETRY } from '../src/features/walk/chart';
import { CSS_NO_COMMENTS } from './helpers/stylesheet';

const SERIES: FeatureSeries = {
  title: 'Every manual survey at this site',
  points: [
    { label: 'May 2007', value: 600 },
    { label: 'May 2010', value: 1200 },
    // Not measured: a gap, not a short bar.
    { label: 'May 2015', value: null },
    { label: 'May 2020', value: 2000 },
    { label: 'May 2026', value: 13272 },
  ],
  discrete: true,
  unit: 'pedestrians',
};

function svg(): SVGSVGElement {
  const found = screen.getByTestId('wnyc-chart-svg');
  expect(found).toBeInstanceOf(SVGSVGElement);
  return found as unknown as SVGSVGElement;
}

function rects(): SVGRectElement[] {
  return [...svg().querySelectorAll('rect')];
}

describe('the geometry is one bar per measured survey, and nothing else', () => {
  it('emits exactly one bar per point with a value', () => {
    const bars = buildSurveyBars(SERIES.points);
    expect(bars).toHaveLength(countSurveys(SERIES.points));
    expect(bars).toHaveLength(4);
  });

  it('emits NO bar for a survey the source did not fully measure', () => {
    const bars = buildSurveyBars(SERIES.points);
    expect(bars.map((bar) => bar.label)).toEqual(['May 2007', 'May 2010', 'May 2020', 'May 2026']);
  });

  it('emits no midpoints — the values are the published totals, unmodified', () => {
    // A line or a smoothed curve would have a value BETWEEN two surveys. Asserting on the exact
    // set, rather than "close to", is what makes this an interpolation test: the mean of 600
    // and 1200 is 900 and nothing in the output is 900.
    const bars = buildSurveyBars(SERIES.points);
    expect(bars.map((bar) => bar.value)).toEqual([600, 1200, 2000, 13272]);
    expect(bars.some((bar) => bar.value === 900)).toBe(false);
    expect(bars.some((bar) => bar.value === 1600)).toBe(false);
    expect(bars.some((bar) => bar.value === (2000 + 13272) / 2)).toBe(false);
  });

  it('scales so the tallest MEASURED survey reaches the top of the plot', () => {
    const bars = buildSurveyBars(SERIES.points);
    const peak = bars.find((bar) => bar.label === 'May 2026');
    expect(peak?.height).toBe(
      CHART_GEOMETRY.height - CHART_GEOMETRY.paddingTop - CHART_GEOMETRY.paddingBottom,
    );
  });

  it('never draws a bar at zero width, however many surveys there are', () => {
    const many = buildSurveyBars(
      Array.from({ length: 400 }, (_unused, index) => ({ label: `May ${2000 + index}`, value: 100 })),
    );
    for (const bar of many) expect(bar.width).toBeGreaterThanOrEqual(CHART_GEOMETRY.minBarWidth);
  });

  it('draws a survey of zero people as a visible hairline, because that was measured', () => {
    const bars = buildSurveyBars([{ label: 'May 2026', value: 0 }]);
    expect(bars).toHaveLength(1);
    expect(bars[0]?.height).toBeGreaterThan(0);
  });

  it('a flat site is a row of full-height bars, not a row of stubs', () => {
    const bars = buildSurveyBars([
      { label: 'May 2010', value: 900 },
      { label: 'May 2026', value: 900 },
    ]);
    expect(bars[0]?.height).toBe(bars[1]?.height);
  });

  it('marks the FIRST and the LAST bar, and only those two', () => {
    const bars = buildSurveyBars(SERIES.points);
    expect(bars.filter((bar) => bar.isFirst)).toHaveLength(1);
    expect(bars.filter((bar) => bar.isLatest)).toHaveLength(1);
    expect(bars.find((bar) => bar.isLatest)?.label).toBe('May 2026');
  });

  it('returns nothing at all for an all-null series', () => {
    expect(buildSurveyBars([{ label: 'May 2026', value: null }])).toEqual([]);
  });
});

describe('the rendered SVG contains bars and an axis, and no connector', () => {
  it('renders one rect per measured survey', () => {
    render(<WalkSeriesChart series={SERIES} />);
    expect(rects()).toHaveLength(4);
  });

  it('renders NO path and NO polyline — there is nothing to interpolate along', () => {
    render(<WalkSeriesChart series={SERIES} />);
    expect(svg().querySelectorAll('path')).toHaveLength(0);
    expect(svg().querySelectorAll('polyline')).toHaveLength(0);
    expect(svg().querySelectorAll('polygon')).toHaveLength(0);
  });

  it('renders exactly ONE line, and it is the axis — not a segment between two surveys', () => {
    render(<WalkSeriesChart series={SERIES} />);
    const lines = [...svg().querySelectorAll('line')];
    expect(lines).toHaveLength(1);
    // The axis sits at the bottom of the plot. A connector would sit between two bars.
    const plotBottom = CHART_GEOMETRY.paddingTop + CHART_GEOMETRY.height - CHART_GEOMETRY.paddingTop - CHART_GEOMETRY.paddingBottom;
    expect(Number(lines[0]?.getAttribute('y1'))).toBe(plotBottom);
  });

  it('every rect carries its survey label and its total, so the picture is inspectable', () => {
    render(<WalkSeriesChart series={SERIES} />);
    expect(rects().map((rect) => rect.getAttribute('data-label'))).toEqual([
      'May 2007',
      'May 2010',
      'May 2020',
      'May 2026',
    ]);
    expect(rects().map((rect) => rect.getAttribute('data-value'))).toEqual([
      '600',
      '1200',
      '2000',
      '13272',
    ]);
  });

  it('the most recent survey is the only one painted in full ink, so "now" survives greyscale', () => {
    render(<WalkSeriesChart series={SERIES} />);
    const latest = rects().filter((rect) => rect.getAttribute('data-latest') === 'true');
    expect(latest).toHaveLength(1);
    expect(latest[0]?.getAttribute('data-label')).toBe('May 2026');
  });

  it('labels the FIRST and the LAST survey on the axis, and nothing between them', () => {
    render(<WalkSeriesChart series={SERIES} />);
    const ticks = [...svg().querySelectorAll('text')].map((node) => node.textContent);
    expect(ticks).toEqual(['May 2007', 'May 2026']);
  });

  it('an x axis with two ticks cannot be read as a continuous time scale', () => {
    // Three or more interior ticks would invite a reader to interpolate between them. Two
    // endpoints and a caption saying "one bar each" cannot.
    render(<WalkSeriesChart series={SERIES} />);
    expect(svg().querySelectorAll('text').length).toBe(2);
    // Queried on the figure rather than the document: the same sentence is the chart's
    // `aria-label`, so a document-wide `getByText` finds it twice — once as the label, once as
    // the visible caption.
    const caption = svg().closest('figure')?.querySelector('figcaption');
    expect(caption?.textContent).toMatch(/separate manual surveys, one bar each/i);
  });
});

describe('the chart has a text alternative, and it names numbers', () => {
  it('is exposed as an image with an aria-label, and repeats it as a <title>', () => {
    render(<WalkSeriesChart series={SERIES} />);
    const label = svg().getAttribute('aria-label');
    expect(label).toBeTruthy();
    expect(svg().getAttribute('role')).toBe('img');
    expect(svg().querySelector('title')?.textContent).toBe(label);
  });

  it('says how many surveys, and that they are not a continuous series', () => {
    const text = chartTextAlternative(SERIES.title, SERIES.points, buildSurveyBars(SERIES.points), SERIES.unit);
    expect(text).toContain('4 separate manual surveys');
    expect(text).toContain('not a continuous series');
  });

  it('names the first, the most recent and the peak, in numbers', () => {
    const text = chartTextAlternative(SERIES.title, SERIES.points, buildSurveyBars(SERIES.points), SERIES.unit);
    expect(text).toContain('The first, May 2007, counted 600 pedestrians');
    expect(text).toContain('The most recent, May 2026, counted 13,272 pedestrians');
    expect(text).toContain('The highest count was 13,272 pedestrians in May 2026');
  });

  it('says the direction in words rather than leaving the reader to compare two numbers', () => {
    const text = chartTextAlternative(SERIES.title, SERIES.points, buildSurveyBars(SERIES.points), SERIES.unit);
    expect(text).toContain('That is up 12,672 pedestrians on the first survey');
  });

  it('says so when the endpoints are equal', () => {
    const flat: FeatureSeries = {
      ...SERIES,
      points: [
        { label: 'May 2010', value: 900 },
        { label: 'May 2026', value: 900 },
      ],
    };
    const text = chartTextAlternative(flat.title, flat.points, buildSurveyBars(flat.points), flat.unit);
    expect(text).toContain('counted the same number of people');
  });

  it('says the one sentence that stops the chart being over-read', () => {
    const text = chartTextAlternative(SERIES.title, SERIES.points, buildSurveyBars(SERIES.points), SERIES.unit);
    expect(text).toContain('Nothing between two surveys was measured.');
  });

  it('says how many surveys are MISSING and why, rather than quietly dropping them', () => {
    const text = chartTextAlternative(SERIES.title, SERIES.points, buildSurveyBars(SERIES.points), SERIES.unit);
    expect(text).toContain('1 further survey is not shown');
    expect(text).toContain('a period was not measured');
  });

  it('pluralises the omitted count correctly', () => {
    const withTwo = buildSurveyBars([
      { label: 'May 2010', value: 100 },
      { label: 'May 2015', value: null },
      { label: 'May 2020', value: null },
    ]);
    const text = chartTextAlternative(SERIES.title, [
      { label: 'May 2010', value: 100 },
      { label: 'May 2015', value: null },
      { label: 'May 2020', value: null },
    ], withTwo, SERIES.unit);
    expect(text).toContain('2 further surveys are not shown');
  });

  it('handles an empty series with a sentence rather than an empty picture', () => {
    const empty: FeatureSeries = { ...SERIES, points: [] };
    render(<WalkSeriesChart series={empty} />);
    expect(screen.getByTestId('wnyc-chart-empty')).toBeInTheDocument();
    expect(screen.queryByTestId('wnyc-chart-svg')).not.toBeInTheDocument();
  });
});

describe('a series marked continuous is refused rather than quietly smoothed', () => {
  it('renders a refusal instead of a chart', () => {
    // The walk pipeline cannot produce this — the validator refuses `interpolate: true` — but
    // the promise to whoever reuses this component is that a continuous series is not drawn,
    // and a promise with no assertion behind it is a comment.
    const continuous: FeatureSeries = { ...SERIES, discrete: false };
    render(<WalkSeriesChart series={continuous} />);
    expect(screen.getByTestId('wnyc-chart-refused')).toBeInTheDocument();
    expect(screen.queryByTestId('wnyc-chart-svg')).not.toBeInTheDocument();
  });

  it('names the reason, so the refusal reads as a decision rather than a failure', () => {
    const continuous: FeatureSeries = { ...SERIES, discrete: false };
    render(<WalkSeriesChart series={continuous} />);
    expect(screen.getByTestId('wnyc-chart-refused').textContent).toMatch(
      /measurements NYC DOT never took/,
    );
  });
});

describe('the chart animates nothing, so there is nothing for reduced motion to switch off', () => {
  it('the stylesheet section for this feature adds no transition or animation', () => {
    // Read rather than assumed: a `@keyframes` or a `transition` on any `wnyc-` rule would be
    // something `prefers-reduced-motion` had to catch, and this component deliberately has
    // nothing to catch.
    const walk = CSS_NO_COMMENTS.slice(CSS_NO_COMMENTS.indexOf('WHERE NYC WALKS'));
    const animated = walk.split('}').filter((block) => /transition:|animation:|@keyframes/.test(block));
    expect(animated.filter((block) => !block.includes('transition: none'))).toEqual([]);
  });
});
