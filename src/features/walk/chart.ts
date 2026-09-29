/**
 * INTEGRATION NOTES (src/features/walk/chart.ts)
 *
 * The geometry of the survey chart, as pure numbers. No React, no DOM, no MapLibre — the
 * component in `WalkSeriesChart.tsx` is a thin shell over this, and every claim the chart
 * makes is therefore testable without rendering anything.
 *
 * WHY BARS AND NOT A LINE
 * ----------------------
 * These are DISCRETE SURVEYS. DOT sends someone to a screenline two or three times a year
 * and counts for three periods; the source publishes those days and nothing between them. A
 * line between May 2007 and September 2007 asserts a shape for the spring of 2007 that no
 * one walked up and measured, and a smooth curve asserts more still.
 *
 * So the chart draws one BAR PER SURVEY and connects nothing. There is no `path`, no
 * `polyline` and no `line` element anywhere in the component, and the geometry below emits
 * only rectangles — which is a stronger guarantee than "we dashed the connector", because
 * there is no connector to misread. A bar is unmistakably a measurement, and the gap between
 * two bars is unmistakably a gap.
 *
 * The axis is therefore also discrete: two labelled ticks, the first survey and the last,
 * with the note that the marks between them are individual surveys. The chart title says the
 * same thing in words, and `series.discrete` is set to true in `detail.ts` so the registry
 * — and any other renderer the shell builds — is told the same.
 *
 * A site has 26 to 37 surveys. At 37 bars in a chart of this width each is under 3px, so the
 * minimum bar width and the gap are both parameters and the arithmetic below is written to
 * survive that: bars are never drawn at zero width, and a survey of 0 people is drawn as a
 * hairline of visible height rather than as nothing at all, because "measured nobody" is a
 * measurement and an absent bar is not.
 *
 * Public surface:
 *   type SurveyBar, buildSurveyBars, chartTextAlternative, countSurveys
 */

import { CHART_STYLE } from './style';

export interface SurveyBar {
  /** The source's own label, e.g. "September 2024". Never reformatted. */
  readonly label: string;
  readonly value: number;
  /** SVG user units, origin top-left. */
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  /** True for the most recent survey, which is the only one painted in full ink. */
  readonly isLatest: boolean;
  /** True for the first survey, so the axis can label it. */
  readonly isFirst: boolean;
}

/** The height of a survey of zero people. Present, thin, and visibly not a missing bar. */
const ZERO_BAR_HEIGHT = 2;

export interface ChartGeometry {
  readonly width: number;
  readonly height: number;
  readonly paddingTop: number;
  readonly paddingBottom: number;
  readonly paddingStart: number;
  readonly paddingEnd: number;
  readonly gap: number;
  readonly minBarWidth: number;
}

/** The published chart geometry, overridable so a test can assert on exact pixels. */
export const CHART_GEOMETRY: ChartGeometry = {
  width: 320,
  height: CHART_STYLE.height,
  paddingTop: CHART_STYLE.paddingTop,
  paddingBottom: CHART_STYLE.paddingBottom,
  paddingStart: CHART_STYLE.paddingStart,
  paddingEnd: CHART_STYLE.paddingEnd,
  gap: CHART_STYLE.gap,
  minBarWidth: CHART_STYLE.minBarWidth,
};

interface SeriesPoint {
  readonly label: string;
  readonly value: number | null;
}

/**
 * One bar per survey, in the order the source published them.
 *
 * A `null` value — a period the source did not measure — is SKIPPED rather than drawn as
 * zero, and the bar indices that come after it shift left. The contract's rule is that a null
 * period was never measured, so drawing it as a zero-height bar would be the same mistake as
 * interpolating: it would put a mark on a day DOT did not count. The gap it leaves is the
 * honest rendering.
 *
 * The scale is the maximum measured total, so the tallest bar always reaches the top of the
 * plot. A flat site therefore has a full-height row of bars rather than a row of stubs,
 * which is what a reader comparing two sites needs.
 */
export function buildSurveyBars(
  points: readonly SeriesPoint[],
  geometry: ChartGeometry = CHART_GEOMETRY,
): SurveyBar[] {
  const measured = points.filter((point) => point.value !== null);
  if (measured.length === 0) return [];

  const plotWidth = Math.max(0, geometry.width - geometry.paddingStart - geometry.paddingEnd);
  const plotHeight = Math.max(0, geometry.height - geometry.paddingTop - geometry.paddingBottom);
  const slot = measured.length <= 1 ? plotWidth : plotWidth / measured.length;
  const barWidth = Math.max(geometry.minBarWidth, slot - geometry.gap);
  const peak = measured.reduce((max, point) => Math.max(max, point.value ?? 0), 0);

  // The most recent MEASURED survey is the one painted in ink, whatever its position in the
  // published order — a skipped trailing period must not leave the chart without a "now".
  let latestIndex = -1;
  for (let index = 0; index < measured.length; index += 1) {
    if ((measured[index]?.value ?? null) !== null) latestIndex = index;
  }

  const bars: SurveyBar[] = [];
  let slotIndex = 0;
  for (const point of points) {
    if (point.value === null) continue;
    const value = point.value;
    const scaled = peak === 0 ? plotHeight : (value / peak) * plotHeight;
    const height = Math.max(ZERO_BAR_HEIGHT, scaled);
    const isLatest = slotIndex === latestIndex;
    bars.push({
      label: point.label,
      value,
      x: geometry.paddingStart + slotIndex * slot,
      y: geometry.paddingTop + (plotHeight - height),
      width: barWidth,
      height,
      isLatest,
      isFirst: slotIndex === 0,
    });
    slotIndex += 1;
  }
  return bars;
}

/** How many surveys the series actually carries, for the words and not for the geometry. */
export function countSurveys(points: readonly SeriesPoint[]): number {
  return points.reduce((total, point) => (point.value === null ? total : total + 1), 0);
}

/**
 * THE TEXT ALTERNATIVE. One paragraph a screen reader gets instead of the picture, and the
 * first thing any renderer should reach for: the shape, the endpoints, the peak, the
 * direction, and the fact that the marks are separate surveys.
 *
 * It names numbers, so the chart is not colour, size or position dependent. It also says
 * "surveys", never "over time", because a reader who hears "over time" hears a line.
 *
 * The SKIPPED count is in here because a survey whose midday period was not measured is not
 * drawn at all — its total is the sum of two periods where every other bar is the sum of
 * three, and a shorter bar would read as a quieter day rather than a partial count. Seven of
 * the 4 107 published surveys are in that state, and saying so is the difference between a
 * gap and a lie. The rule is the source's own: a null period was never measured.
 */
export function chartTextAlternative(
  title: string,
  points: readonly SeriesPoint[],
  bars: readonly SurveyBar[],
  unit: string,
): string {
  const count = (value: number): string => `${value.toLocaleString('en-US')} ${unit}`;

  if (bars.length === 0) return `${title}. No surveys were published for this site.`;

  const first = bars[0];
  const last = bars[bars.length - 1];
  if (first === undefined || last === undefined) {
    return `${title}. No surveys were published for this site.`;
  }

  const peak = bars.reduce((best, bar) => (bar.value > best.value ? bar : best), first);
  const difference = last.value - first.value;

  const omitted = points.length - bars.length;
  const parts = [
    `${title}.`,
    `${bars.length} separate manual surveys, one bar each, not a continuous series.`,
    `The first, ${first.label}, counted ${count(first.value)}.`,
    `The most recent, ${last.label}, counted ${count(last.value)}.`,
    `The highest count was ${count(peak.value)} in ${peak.label}.`,
    difference === 0
      ? 'The first and the most recent survey counted the same number of people.'
      : `That is ${difference > 0 ? 'up' : 'down'} ${count(Math.abs(difference))} on the first survey.`,
    'Nothing between two surveys was measured.',
  ];

  if (omitted > 0) {
    parts.push(
      `${omitted} further ${omitted === 1 ? 'survey is' : 'surveys are'} not shown, because a period was not measured on the day and a partial total would read as a quieter day.`,
    );
  }

  return parts.join(' ');
}
