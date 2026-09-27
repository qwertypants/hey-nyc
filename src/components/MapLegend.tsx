/**
 * The legend. Its job is to make the map's three dining types readable WITHOUT colour, and
 * to say out loud the one operational fact the dataset does contain.
 *
 * Every type is encoded four ways, taken from `src/map/style.ts` and never re-derived here:
 * the real swatch shape (disc / rimmed disc / ring), the real size, the real colour, and the
 * real words — both the label and the shape's description. Someone who cannot separate
 * #b45309 from #6d28d9, or who is looking at this in greyscale, still reads "Roadway dining,
 * large circle with a heavy dark rim".
 *
 * The footnote is the part that protects the visitor. The source has no hours, no rating, no
 * price and no menu (docs/data-dictionary.md §2), so someone standing outside in January
 * needs the one seasonal fact we DO have: roadway licences run April 1 – November 29.
 *
 * It is a collapsed `<details>` because the map is the point; the legend is one tap away
 * and does not compete with it.
 */

import type { JSX } from 'react';
import { DINING_TYPE_STYLE_LIST } from '../map/style';
import { ROADWAY_SEASON_END, ROADWAY_SEASON_START } from '../lib/format';

export function MapLegend(): JSX.Element {
  return (
    <details className="eoy-legend">
      <summary className="eoy-legend__summary">Legend</summary>
      <ul className="eoy-legend__list">
        {DINING_TYPE_STYLE_LIST.map((style) => (
          <li className="eoy-legend-item" key={style.type}>
            <span
              className={`eoy-legend-item__shape eoy-legend-item__shape--${style.shape}`}
              aria-hidden="true"
            />
            <span>
              <span className="eoy-legend-item__label">{style.label}</span>
              <span className="eoy-legend-item__shape-text">{style.shapeDescription}</span>
            </span>
          </li>
        ))}
      </ul>
      <p className="eoy-legend__note">
        Roadway dining may operate from {ROADWAY_SEASON_START} through {ROADWAY_SEASON_END}.
      </p>
    </details>
  );
}
