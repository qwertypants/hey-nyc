/**
 * INTEGRATION NOTES (src/features/walk/WalkLegend.tsx)
 *
 * The legend, rendered from the registry's own `LegendConfig` so the shell can drop it in
 * without knowing anything about trends, activity levels or staleness.
 *
 *   <WalkLegend legend={feature.legend} />
 *
 * A CONVENIENCE, NOT THE CONTRACT. The deliverable is `feature.legend: LegendConfig`; this
 * component is a faithful renderer of it, so a shell that would rather draw its own gets the
 * same words in the same order. It is a `<details>`, like `MapLegend`, because the map is the
 * point and the legend is one tap away.
 *
 * EVERY SWATCH CARRIES ITS SHAPE, NOT ONLY ITS COLOUR
 * --------------------------------------------------
 * The registry's `LegendSwatch` has a required `symbol` field for exactly this: a
 * screen-reader description of the MARK, because colour is never the only channel in this app.
 * Here it is rendered twice over — as text under the label, and as a real drawn glyph beside
 * it, so the swatch a sighted reader sees is the same shape the map paints:
 *
 *   - a trend swatch is a solid circle, so a filled disc, with the rim drawn at the trend's
 *     own weight. A `rising` swatch has a heavy ring and a `flat` one has none, which is the
 *     shape difference the map layer makes and a reader can check against.
 *   - an activity swatch is a ring around a core, with the `+` / `x` at the centre and the
 *     core's opacity from staleness. A `no recent reading` swatch is therefore visibly hollow.
 *
 * THE `note` IS RENDERED, NOT LINKED. It is the honesty sentence and it lives inside the
 * legend body where a visitor reads it without opening a page. The `aboutHref` sits below it
 * as a real link, so the methodology is one click away and never more than one.
 *
 * Public surface:
 *   WalkLegend, WalkLegendProps
 */

import type { CSSProperties, JSX } from 'react';
import type { SensorActivity, Trend } from '../../types/walk';
import { ACTIVITY_STYLES, STALENESS_STYLES, TREND_STYLES } from './style';
import type { LegendConfig, LegendSwatch } from '../registry';

export interface WalkLegendProps {
  readonly legend: LegendConfig;
}

const TREND_PREFIX = 'trend-';
const ACTIVITY_PREFIX = 'activity-';

/**
 * The swatch id is the contract between `legend.ts` and this file, so it is parsed rather
 * than cast: an id whose suffix is not one of the contract's enums falls through to the
 * plain fill instead of being forced into a style that does not exist.
 */
function swatchStyle(swatch: LegendSwatch): CSSProperties {
  if (swatch.id.startsWith(TREND_PREFIX)) {
    const trend = swatch.id.slice(TREND_PREFIX.length) as Trend;
    const style = TREND_STYLES[trend];
    if (style === undefined) return { ['--wnyc-swatch' as string]: swatch.color };
    return {
      ['--wnyc-swatch' as string]: swatch.color,
      ['--wnyc-swatch-core' as string]: swatch.color,
      ['--wnyc-swatch-ring' as string]: `${style.strokeWidth}px`,
      ['--wnyc-swatch-hollow' as string]: '1',
    };
  }
  if (swatch.id.startsWith(ACTIVITY_PREFIX)) {
    const activity = swatch.id.slice(ACTIVITY_PREFIX.length) as SensorActivity;
    const style = ACTIVITY_STYLES[activity];
    if (style === undefined) return { ['--wnyc-swatch' as string]: swatch.color };
    return {
      ['--wnyc-swatch' as string]: 'transparent',
      ['--wnyc-swatch-core' as string]: swatch.color,
      ['--wnyc-swatch-ring' as string]: `${STALENESS_STYLES.fresh.ringWidth}px`,
      // The core's opacity, so a hollow "no recent reading" swatch is visibly hollow.
      ['--wnyc-swatch-hollow' as string]: style.isLevel ? '1' : '0.08',
    };
  }
  return { ['--wnyc-swatch' as string]: swatch.color };
}

export function WalkLegend({ legend }: WalkLegendProps): JSX.Element {
  return (
    <details className="wnyc-legend">
      <summary className="wnyc-legend__summary">Legend</summary>

      {/*
        `role="group"` with a name, so the nine swatches are announced as one thing rather
        than as nine loose list items the reader has to work out the relationship between. The
        `<details>` element already gives the summary the disclosure semantics; this adds the
        grouping inside it.
      */}
      <ul className="wnyc-legend__list" role="group" aria-label={legend.title}>
        {legend.swatches.map((swatch) => (
          <li className="wnyc-legend__item" key={swatch.id}>
            <span className="wnyc-legend__swatch" style={swatchStyle(swatch)} aria-hidden="true" />
            <span className="wnyc-legend__text">
              <span className="wnyc-legend__label">{swatch.label}</span>
              <span className="wnyc-legend__symbol">{swatch.symbol}</span>
            </span>
          </li>
        ))}
      </ul>

      <p className="wnyc-legend__note">{legend.note}</p>

      {legend.aboutHref === undefined ? null : (
        <a
          className="wnyc-legend__about"
          href={legend.aboutHref}
          rel="noreferrer noopener"
          target="_blank"
        >
          How these counts are collected
          <span className="wnyc-visually-hidden"> (opens in a new tab)</span>
        </a>
      )}
    </details>
  );
}
