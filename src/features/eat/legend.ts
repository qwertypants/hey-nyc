/**
 * The Eat Outside legend, in the registry's vocabulary.
 *
 * This used to be `src/components/MapLegend.tsx`, and it was the app's own component reading
 * `DINING_TYPE_STYLE_LIST` directly. It is now DATA: the shell's generic `ShellLegend` draws
 * whatever `LegendConfig` says, and the only thing left here is the four things the map's
 * vocabulary already knew — the three shapes, their labels, the words for the shape, and the
 * one operational fact DOT publishes.
 *
 * The two channels that must not be lost in the translation, and are not:
 *
 *   SHAPE. `swatch.id` is the CSS modifier (`disc`, `rimmed-disc`, `ring`), so the swatch is
 *   the same SHAPE the layer paints rather than a flat colour in the same colour. That is
 *   why `ShellLegend` treats a non-empty `id` as "this feature has a stylesheet for it" and
 *   only falls back to `swatch.color` for an empty one.
 *
 *   THE NOTE. `LegendConfig.note` is required by the registry for a reason stated there, and
 *   for Eat Outside it is the one sentence a person standing outside in January needs:
 *   roadway licences run April 1 – November 29. It is inside the legend, not in a help page.
 *
 * Public surface:
 *   PLACE_NOUNS, EAT_LEGEND: LegendConfig
 */

import type { LegendConfig, Nouns } from '../registry';
import { DINING_TYPE_STYLE_LIST } from '../../map/style';
import { ROADWAY_SEASON_END, ROADWAY_SEASON_START } from '../../lib/format';

/**
 * The noun every count in Eat Outside is built from. "3 places" is a claim about the licence
 * dataset specifically, so it lives with the rest of the feature's vocabulary rather than in
 * the shell, which renders the count but has no business choosing the word.
 */
export const PLACE_NOUNS: Nouns = { one: 'place', many: 'places' };

export const EAT_LEGEND: LegendConfig = {
  // The summary of the `<details>` is the one word a visitor scans for, and it has said
  // "Legend" since the first release; the registry's `title` is that word.
  title: 'Legend',
  swatches: DINING_TYPE_STYLE_LIST.map((style) => ({
    id: style.shape,
    label: style.label,
    color: style.color,
    symbol: style.shapeDescription,
  })),
  note: `Roadway dining may operate from ${ROADWAY_SEASON_START} through ${ROADWAY_SEASON_END}.`,
};
