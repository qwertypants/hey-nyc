/**
 * THE THREE RENDER FUNCTIONS THIS FEATURE HANDS THE SHELL.
 *
 * `src/features/walk/feature.ts` is a pure `.ts` module — no React, no JSX — so the whole
 * feature can be unit-tested without a renderer in the module graph. This is where the three
 * React-shaped slots actually get their JSX, and it is a separate file for exactly that
 * reason: three small adapters, each of which is otherwise a one-line closure that would
 * force the factory into a `.tsx`.
 *
 * THE SHEET REUSES THE SHELL'S CHROME, and that is the decision worth stating. This feature
 * brings its own BODY — `WalkDetailBody`, with the survey chart and the per-item caveat — but
 * it does not bring its own `role="dialog"`, its own focus trap, its own Escape handling or
 * its own close button. Those are not a feature's to get right: `aria-modal` is only honest
 * while the rest of the app is really `inert`, and a hand-rolled focus trap is a keyboard
 * trap the day somebody gets it wrong. So it renders `ShellDetailSheet` with a `body`, and
 * the header still comes from `FeatureDetail` — which is why a custom body can never produce
 * an unlabelled dialog.
 *
 * Public surface:
 *   walkLegendSlot, walkSortSlot, walkSheetSlot
 */

import type { JSX } from 'react';
import type {
  LegendConfig,
  SheetSlotContext,
  SortSlotContext,
} from '../registry';
import { ShellDetailSheet } from '../shell/ShellDetailSheet';
import { walkDetail } from './detail';
import { WalkDetailBody } from './WalkDetailBody';
import { WalkLegend } from './WalkLegend';
import { WALK_DEFAULT_SORT } from './rows';
import { WalkSortControl } from './WalkSortControl';
import type { WalkFeatureSource } from '../../data/walk/source';
import type { WalkItem } from '../../data/walk/validate';
import type { FeatureData } from '../registry';

export function walkLegendSlot(legend: LegendConfig): JSX.Element {
  return <WalkLegend legend={legend} />;
}

/**
 * The three orders, each with its definition printed on it.
 *
 * `sort` arrives as `null` before the visitor has chosen one, and this control then shows
 * `WALK_DEFAULT_SORT` as selected — so the list has to be in that order too, and
 * `walkRows` guarantees it. That is the whole reason the two constants share a name.
 */
export function walkSortSlot(context: SortSlotContext): JSX.Element {
  return (
    <WalkSortControl
      sort={context.sort ?? WALK_DEFAULT_SORT}
      origin={context.origin}
      onChange={context.onChange}
      defaultSort={WALK_DEFAULT_SORT}
    />
  );
}

/**
 * The detail sheet for one selected id, or `null` for an id this feature does not have.
 *
 * The `null` is not defensive: the shell only opens a sheet for an id the ACTIVE feature
 * resolved, and it resolves through the very same `walkDetail` call. Returning `null` rather
 * than a half-sheet means a race — a selection cleared between the resolve and the render —
 * closes the sheet rather than showing a dialog with an empty body.
 */
export function walkSheetSlot(
  context: SheetSlotContext,
  data: FeatureData<WalkItem>,
  source: WalkFeatureSource,
  now: number,
): JSX.Element | null {
  const detail = walkDetail(data.byId.get(context.id), source.patterns, source.latestById, now);
  if (detail === null) return null;

  return (
    <ShellDetailSheet
      detail={detail}
      onClose={context.onClose}
      {...(context.onShowOnMap === undefined ? {} : { onShowOnMap: context.onShowOnMap })}
      body={<WalkDetailBody detail={detail} />}
    />
  );
}
