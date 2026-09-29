/**
 * THE ACCESSIBLE ALTERNATIVE TO THE MAP. Not a fallback, not a "results" page — the primary
 * way to read the dataset for anyone who cannot drag a map, and a complete one: every item
 * in the current area is reachable by keyboard and by screen reader, at every zoom.
 *
 * This was `src/components/LocationList.tsx` and it was typed to `VisibleLocation` and to
 * `LocationProperties`. It is now typed to `FeatureRow`, which is three pre-formatted
 * strings and a shape, and it never learns what a borough is. The decisions survived:
 *
 * - Rows are real `<button>`s inside a plain list. Each is 44px tall, the whole row is the
 *   target, and `aria-current` marks the selection. `aria-current` rather than
 *   `aria-selected` because a row is an ACTION (select this item and fly there), not an
 *   option in a single-select widget; `aria-selected` on a button is invalid, and building a
 *   listbox here would mean re-implementing roving tabindex to do the same job badly.
 * - Distance is rendered only when `origin` is a real position, which the FEATURE decided.
 *   A row measured from the centre of the city — which is what "nearby" would otherwise
 *   silently mean — simply has no distance. Better absent than wrong.
 * - The row repeats the map's real shape in words and in a swatch taken from the map's own
 *   stylesheet. Colour is never the only signal, and `tests/axe.test.tsx` asserts that the
 *   shape's words are in the row's accessible name.
 * - A cap keeps a citywide view from mounting 2 000 rows, and the cap is stated on screen
 *   with a button that lifts it. The whole dataset stays reachable; only the initial paint
 *   is bounded. The cap is the shell's, because the shell owns the "revealed" count.
 * - The list is keyed off the map's own extent, so it follows the map. The heading says so,
 *   and the empty state offers the two honest ways out: fit the map to the results, or drop
 *   the filters.
 *
 * The NOUNS are the feature's. "3 places in this area" and "114 count sites in this area"
 * are different claims about different datasets, and the shell has no business choosing
 * between them.
 *
 * Public surface:
 *   DEFAULT_VISIBLE_LIMIT, ShellListProps, ShellList(props): JSX.Element
 */

import type { JSX, ReactNode, RefObject } from 'react';
import { ListEmptyState } from '../../components/StateCards';
import type { FeatureRow, Nouns } from '../registry';
import { formatPluralizedCount } from '../../lib/format';

export interface ShellListProps {
  readonly visible: boolean;
  readonly rows: readonly FeatureRow[];
  /** Untruncated size of the same set, so "60 of 1,432" can be honest. */
  readonly total: number;
  /** Matches in the whole dataset under the active filters. */
  readonly datasetCount: number;
  readonly filtered: boolean;
  readonly nouns: Nouns;
  /** The active feature's own words for the filter dimensions, and what to try next. */
  readonly filtering: { readonly dimensions: string; readonly retryHint: string };
  readonly selectedId: string | null;
  readonly revealed: number;
  /** Focused by the skip link, so it is the documented landing point for keyboard users. */
  readonly headingRef: RefObject<HTMLHeadingElement | null>;
  /**
   * The active feature's own control for ORDERING this list, if it has one. `null` renders
   * nothing, which is the normal case and not an omission: Eat Outside's list is in name
   * order and there is no other order worth offering.
   *
   * It lives HERE, below the heading and above the rows, and not in the header. A sort
   * orders a list, so it belongs with the list; and the header's height is derived in
   * `src/index.css` from the three rows it is supposed to have, so a fourth one there
   * silently invalidates a number the wide-layout detail sheet reads. The control also
   * changes what the rows are, and the rows are the thing the visitor is looking at when
   * they go looking for a way to change them.
   */
  readonly sortControl?: ReactNode;
  readonly onRevealMore: () => void;
  readonly onSelect: (id: string) => void;
  readonly onZoomToAll: () => void;
  readonly onClearFilters: () => void;
}

/** Cap so a citywide view does not mount two thousand rows. */
export const DEFAULT_VISIBLE_LIMIT = 60;

export function ShellList({
  visible,
  rows,
  total,
  datasetCount,
  filtered,
  nouns,
  filtering,
  selectedId,
  revealed,
  headingRef,
  sortControl,
  onRevealMore,
  onSelect,
  onZoomToAll,
  onClearFilters,
}: ShellListProps): JSX.Element {
  const remaining = total - revealed;

  return (
    <section
      className="eoy-list"
      // A literal, and it must stay one. The skip control's `aria-controls` is a literal in
      // `src/App.tsx` and `tests/app-skip-control.test.tsx` resolves it against the live DOM,
      // so a feature-derived id would break the association the day a second feature is
      // switched to — the id would change under a control that names it.
      id="eoy-place-list"
      hidden={!visible}
      aria-label="Places in the current map area"
      data-testid="location-list"
    >
      <div className="eoy-list__head">
        <h2 className="eoy-list__title" ref={headingRef} tabIndex={-1}>
          {formatPluralizedCount(total, nouns.one, nouns.many)} in this area
        </h2>
        <p className="eoy-list__note">
          {filtered
            ? 'Matching the filters above. The list follows the map, so pan or zoom to see more.'
            : 'The list follows the map, so pan or zoom to see more.'}
        </p>
      </div>

      {sortControl === undefined ? null : (
        <div className="eoy-list__controls">{sortControl}</div>
      )}

      {rows.length === 0 ? (
        <ListEmptyState
          inViewCount={total}
          datasetCount={datasetCount}
          filtered={filtered}
          nouns={nouns}
          filtering={filtering}
          onZoomToAll={onZoomToAll}
          onClearFilters={onClearFilters}
        />
      ) : (
        <ul className="eoy-list__items">
          {rows.map((row) => (
            <li key={row.id}>
              <FeatureRowButton row={row} selected={row.id === selectedId} onSelect={onSelect} />
            </li>
          ))}
        </ul>
      )}

      {remaining > 0 ? (
        <div className="eoy-list__more">
          <button
            type="button"
            className="eoy-button eoy-button--ghost"
            onClick={onRevealMore}
          >
            Show {Math.min(remaining, revealed)} more
            <span className="eoy-visually-hidden">
              {` — ${formatPluralizedCount(remaining, nouns.one, nouns.many)} in this area are not shown yet`}
            </span>
          </button>
        </div>
      ) : null}
    </section>
  );
}

interface FeatureRowButtonProps {
  readonly row: FeatureRow;
  readonly selected: boolean;
  readonly onSelect: (id: string) => void;
}

function FeatureRowButton({ row, selected, onSelect }: FeatureRowButtonProps): JSX.Element {
  return (
    <button
      type="button"
      className="eoy-row"
      aria-current={selected}
      onClick={() => onSelect(row.id)}
    >
      <span className="eoy-row__top">
        <span className="eoy-row__name">{row.title}</span>
        {/* Only ever rendered when the feature measured from a real origin. */}
        {row.distance === null ? null : (
          <span className="eoy-row__distance">{row.distance}</span>
        )}
      </span>
      <span className="eoy-row__address">{row.subtitle}</span>
      {row.meta === null ? null : (
        <span className="eoy-row__type">
          {row.symbol === null ? null : (
            <span
              className={`eoy-legend-item__shape eoy-legend-item__shape--${row.symbol}`}
              aria-hidden="true"
            />
          )}{' '}
          {row.meta}
        </span>
      )}
      {/* The registry's per-item qualifier, for a feature that has one ("VERY BUSY",
          "RISING"). Eat Outside has none, and inventing a category would be a claim the
          dataset does not make. */}
      {row.badge === null ? null : (
        <span className="eoy-row__badge">{row.badge}</span>
      )}
    </button>
  );
}
