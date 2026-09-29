/**
 * THE LEGEND, GENERIC.
 *
 * This was `src/components/MapLegend.tsx`, and it read `DINING_TYPE_STYLE_LIST` directly out
 * of `src/map/style.ts`. It is now data: the shell draws whatever `LegendConfig` says, and a
 * feature supplies the swatches. The shell knows how to draw a swatch and nothing about what
 * any of them mean.
 *
 * THREE DECISIONS THAT SURVIVED THE MOVE, and would not have survived a lazy one:
 *
 *   SHAPE, NOT COLOUR. A swatch's `id` is treated as a CSS modifier — `disc`, `rimmed-disc`,
 *   `ring` for Eat Outside — so the swatch is the same SHAPE the layer paints, not a flat
 *   disc in the same colour. That is the whole point of a third channel: "roadway dining" and
 *   "sidewalk dining" have to be separable in greyscale, and a hue cannot do that. A feature
 *   with no stylesheet of its own leaves `id` empty and gets `swatch.color` as a flat dot,
 *   which is honest as long as the WORDS are beside it — which they are, in `symbol`.
 *
 *   COLOUR IS THE REDUNDANT CHANNEL. Every swatch's label names it in words and `symbol`
 *   describes the shape, so 1.4.11 does not apply to the fill and a colour-blind reader is
 *   not excluded.
 *
 *   THE NOTE IS IN THE LEGEND. `LegendConfig.note` is required by the registry for a reason
 *   stated there: a reader who sees 114 dots has to be told those are measurement points and
 *   not a description of foot traffic between them. A help page nobody opens is not that.
 *
 * Public surface:
 *   ShellLegend(props): JSX.Element
 */

import type { JSX } from 'react';
import type { LegendConfig } from '../registry';

export interface ShellLegendProps {
  readonly legend: LegendConfig;
}

export function ShellLegend({ legend }: ShellLegendProps): JSX.Element {
  return (
    <details className="eoy-legend" data-testid="legend">
      <summary className="eoy-legend__summary">{legend.title}</summary>
      {legend.swatches.length === 0 ? null : (
        <ul className="eoy-legend__list">
          {legend.swatches.map((swatch) => (
            <li className="eoy-legend-item" key={swatch.id === '' ? swatch.label : swatch.id}>
              <span
                className={`eoy-legend-item__shape${
                  swatch.id === '' ? '' : ` eoy-legend-item__shape--${swatch.id}`
                }`}
                // Only a swatch with no stylesheet of its own falls back to a flat colour;
                // see the header. An inline colour would beat the modifier classes and
                // quietly turn all three dining shapes into the same disc.
                style={swatch.id === '' ? { backgroundColor: swatch.color } : undefined}
                aria-hidden="true"
              />
              <span>
                <span className="eoy-legend-item__label">{swatch.label}</span>
                <span className="eoy-legend-item__shape-text">{swatch.symbol}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
      <p className="eoy-legend__note">{legend.note}</p>
      {legend.aboutHref === undefined ? null : (
        <p className="eoy-legend__note">
          <a href={legend.aboutHref} target="_blank" rel="noopener noreferrer">
            How these numbers were collected
          </a>
        </p>
      )}
    </details>
  );
}
