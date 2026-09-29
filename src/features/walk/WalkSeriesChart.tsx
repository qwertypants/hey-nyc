/**
 * INTEGRATION NOTES (src/features/walk/WalkSeriesChart.tsx)
 *
 * The survey chart: inline SVG, no charting library, no DOM measurement, no animation.
 *
 * WHY NO CHARTING DEPENDENCY. `AGENTS.md` allows exactly three runtime dependencies and
 * requires an ADR arguing the standard library is not enough before adding a fourth. A chart
 * of 26 to 37 bars needs an x scale, a y scale and two `<rect>` elements. What it does not
 * need is a library, and the two things a library would bring — a continuous line renderer
 * and an animated transition — are the two things that must NOT be here: one would imply
 * measurements DOT never took, and the other would be motion this feature has no reason to
 * add. The whole component is the geometry in `chart.ts` plus this file.
 *
 * WHY THERE IS NO LINE, IN CODE TERMS RATHER THAN IN PROSE
 * ------------------------------------------------------
 * This component contains no `<path>`, no `<polyline>` and no `<line>` element, and the
 * geometry module emits only rectangles. So the absence of interpolation is a property of the
 * code rather than a styling decision a future change could quietly reverse: to connect two
 * surveys somebody would have to ADD a path, and `tests/walk-chart.test.tsx` fails if a path
 * appears. Bars are the strongest available statement of "these are separate measurements" —
 * the gap between two bars is a gap, not a slope.
 *
 * ACCESSIBILITY, and the bar this has to clear
 * -------------------------------------------
 *   - `role="img"` with an `aria-label` carrying the TEXT ALTERNATIVE from `chart.ts`: the
 *     count of surveys, the first, the most recent, the peak, the direction, and the sentence
 *     that nothing in between was measured. A chart with no text alternative is invisible to
 *     a screen-reader user, and this one is the only place a walk site's 19-year record is
 *     visible at all.
 *   - `<title>` inside the SVG as well, so the label is available to anything that reads the
 *     document rather than the accessibility tree.
 *   - NO ANIMATION, therefore nothing for `prefers-reduced-motion` to switch off. The stylesheet
 *     has a `@media (prefers-reduced-motion: reduce)` block for the rest of the app; this
 *     component deliberately adds nothing that block would have to catch.
 *   - The bars are chrome, not data colour, and are held to WCAG 1.4.11 (3:1) in both
 *     schemes by `tests/walk-style.test.ts`. The most recent survey is full ink and the rest
 *     are in the muted rule colour, so "which one is now" survives greyscale.
 *   - The axis labels the FIRST and the LAST survey only, and says "each bar is one survey"
 *     underneath, so the x axis cannot be read as a continuous time scale.
 *
 * Public surface:
 *   WalkSeriesChart, WalkSeriesChartProps
 */

import type { JSX } from 'react';
import { useId } from 'react';
import type { FeatureSeries } from '../registry';
import { buildSurveyBars, chartTextAlternative } from './chart';
import { CHART_STYLE } from './style';

export interface WalkSeriesChartProps {
  readonly series: FeatureSeries;
  /** Overrides the chart's own geometry. Tests pass exact pixels. */
  readonly width?: number;
  readonly height?: number;
}

/**
 * A series marked `discrete: false` is not drawn. This feature's data is discrete by
 * construction — the validator refuses `interpolate: true` — so the branch is unreachable
 * from the walk pipeline, and it is here to make a promise to whoever reuses this component:
 * a continuous series is refused rather than quietly smoothed.
 */
export function WalkSeriesChart({ series, width, height }: WalkSeriesChartProps): JSX.Element {
  const titleId = useId();
  const geometryWidth = width ?? 320;
  const plotHeight = (height ?? CHART_STYLE.height) - CHART_STYLE.paddingTop - CHART_STYLE.paddingBottom;

  const bars = series.discrete
    ? buildSurveyBars(series.points, {
        width: geometryWidth,
        height: height ?? CHART_STYLE.height,
        paddingTop: CHART_STYLE.paddingTop,
        paddingBottom: CHART_STYLE.paddingBottom,
        paddingStart: CHART_STYLE.paddingStart,
        paddingEnd: CHART_STYLE.paddingEnd,
        gap: CHART_STYLE.gap,
        minBarWidth: CHART_STYLE.minBarWidth,
      })
    : [];

  const alternative = chartTextAlternative(series.title, series.points, bars, series.unit);
  const first = bars[0];
  const last = bars[bars.length - 1];

  if (!series.discrete) {
    return (
      <p className="wnyc-chart__refused" data-testid="wnyc-chart-refused">
        This series is marked continuous and is not drawn here: the walk data is a set of
        separate surveys, and drawing a line between two of them would show measurements NYC
        DOT never took.
      </p>
    );
  }

  if (bars.length === 0) {
    return (
      <p className="wnyc-chart__refused" data-testid="wnyc-chart-empty">
        No complete survey is published for this site, so there is nothing to plot.
      </p>
    );
  }

  return (
    <figure className="wnyc-chart" aria-labelledby={titleId}>
      <p className="wnyc-chart__title" id={titleId}>
        {series.title}
      </p>

      <svg
        className="wnyc-chart__svg"
        viewBox={`0 0 ${geometryWidth} ${height ?? CHART_STYLE.height}`}
        width="100%"
        height={height ?? CHART_STYLE.height}
        role="img"
        aria-label={alternative}
        data-testid="wnyc-chart-svg"
        focusable="false"
      >
        <title>{alternative}</title>

        {/*
          The baseline. One horizontal rule, which is an axis rather than a data mark, and it
          is drawn with a 1px stroke so it cannot be mistaken for a zero-height bar.
        */}
        <line
          x1={CHART_STYLE.paddingStart}
          y1={CHART_STYLE.paddingTop + plotHeight}
          x2={geometryWidth - CHART_STYLE.paddingEnd}
          y2={CHART_STYLE.paddingTop + plotHeight}
          stroke={CHART_STYLE.axisColor}
          strokeWidth={1}
        />

        {bars.map((bar) => (
          <rect
            key={bar.label}
            x={bar.x}
            y={bar.y}
            width={bar.width}
            height={bar.height}
            fill={bar.isLatest ? CHART_STYLE.latestBarFill : CHART_STYLE.barFill}
            data-label={bar.label}
            data-value={bar.value}
            data-latest={bar.isLatest ? 'true' : 'false'}
          />
        ))}

        {first === undefined ? null : (
          <text
            className="wnyc-chart__tick"
            x={CHART_STYLE.paddingStart}
            y={CHART_STYLE.paddingTop + plotHeight + 14}
            fill={CHART_STYLE.labelColor}
            fontSize={CHART_STYLE.labelSize}
            textAnchor="start"
          >
            {first.label}
          </text>
        )}
        {last === undefined ? null : (
          <text
            className="wnyc-chart__tick"
            x={geometryWidth - CHART_STYLE.paddingEnd}
            y={CHART_STYLE.paddingTop + plotHeight + 14}
            fill={CHART_STYLE.labelColor}
            fontSize={CHART_STYLE.labelSize}
            textAnchor="end"
          >
            {last.label}
          </text>
        )}
      </svg>

      {/*
        The caption is the second half of the text alternative, in the DOM rather than only in
        the `aria-label` — so it is available to a sighted reader using a magnifier, to a
        screen reader in browse mode, and to anyone who has turned images off entirely.
      */}
      <figcaption className="wnyc-chart__caption">
        {bars.length} separate manual {bars.length === 1 ? 'survey' : 'surveys'}, one bar each. Nothing
        between two surveys was measured.
      </figcaption>
    </figure>
  );
}
