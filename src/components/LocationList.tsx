/**
 * THE ACCESSIBLE ALTERNATIVE TO THE MAP. Not a fallback, not a "results" page — the primary
 * way to read the dataset for anyone who cannot drag a map, and a complete one: every place
 * in the current area is reachable by keyboard and by screen reader, at every zoom.
 *
 * Decisions:
 * - Rows are real `<button>`s inside a plain list. Each is 44px tall, the whole row is the
 *   target, and `aria-current` marks the selection. `aria-current` rather than
 *   `aria-selected` because a row is an ACTION (select this place and fly there), not an
 *   option in a single-select widget; `aria-selected` on a button is invalid, and building a
 *   listbox here would mean re-implementing roving tabindex to do the same job badly.
 * - Distance is rendered only when `origin` is a real position. `distanceMiles` returns
 *   null without one, so a row measured from the centre of the city — which is what "nearby"
 *   would otherwise silently mean — simply has no distance. Better absent than wrong.
 * - The row names the dining type in words, from `describeType`, next to a swatch that
 *   repeats the map's real shape. Colour is never the only signal.
 * - A cap keeps a citywide view from mounting 2 000 rows, and the cap is stated on screen
 *   with a button that lifts it. The whole dataset stays reachable; only the initial paint
 *   is bounded.
 * - The list is keyed off the map's own bounds, so it follows the map. The heading says so,
 *   and the empty state offers the two honest ways out: fit the map to the results, or drop
 *   the filters.
 */

import type { JSX, KeyboardEvent, RefObject } from 'react';
import { useRef } from 'react';
import type { VisibleLocation } from '../hooks/useVisibleLocations';
import { describeType, typeStyle } from '../map/style';
import { formatAddress, formatBoroughCount } from '../lib/format';
import { ListEmptyState } from './StateCards';
import { ListIcon, MapIcon } from './icons';

export interface LocationListProps {
  readonly visible: boolean;
  readonly rows: readonly VisibleLocation[];
  /** Untruncated size of the same set, so "60 of 1,432" can be honest. */
  readonly total: number;
  /** Matches in the whole dataset under the active filters. */
  readonly datasetCount: number;
  readonly filtered: boolean;
  readonly selectedId: string | null;
  readonly revealed: number;
  /** Focused by the skip link, so it is the documented landing point for keyboard users. */
  readonly headingRef: RefObject<HTMLHeadingElement | null>;
  readonly onRevealMore: () => void;
  readonly onSelect: (id: string) => void;
  readonly onZoomToAll: () => void;
  readonly onClearFilters: () => void;
}

export function LocationList({
  visible,
  rows,
  total,
  datasetCount,
  filtered,
  selectedId,
  revealed,
  headingRef,
  onRevealMore,
  onSelect,
  onZoomToAll,
  onClearFilters,
}: LocationListProps): JSX.Element {
  const remaining = total - revealed;

  return (
    <section
      className="eoy-list"
      id="eoy-place-list"
      hidden={!visible}
      aria-label="Places in the current map area"
      data-testid="location-list"
    >
      <div className="eoy-list__head">
        <h2 className="eoy-list__title" ref={headingRef} tabIndex={-1}>
          {formatBoroughCount(total)} in this area
        </h2>
        <p className="eoy-list__note">
          {filtered
            ? 'Matching the filters above. The list follows the map, so pan or zoom to see more.'
            : 'The list follows the map, so pan or zoom to see more.'}
        </p>
      </div>

      {rows.length === 0 ? (
        <ListEmptyState
          inViewCount={total}
          datasetCount={datasetCount}
          filtered={filtered}
          onZoomToAll={onZoomToAll}
          onClearFilters={onClearFilters}
        />
      ) : (
        <ul className="eoy-list__items">
          {rows.map((row) => (
            <li key={row.location.id}>
              <LocationRow
                row={row}
                selected={row.location.id === selectedId}
                onSelect={onSelect}
              />
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
              {` — ${remaining} places in this area are not shown yet`}
            </span>
          </button>
        </div>
      ) : null}
    </section>
  );
}

interface LocationRowProps {
  readonly row: VisibleLocation;
  readonly selected: boolean;
  readonly onSelect: (id: string) => void;
}

function LocationRow({ row, selected, onSelect }: LocationRowProps): JSX.Element {
  const { location, distance } = row;
  const style = typeStyle(location.type);

  return (
    <button
      type="button"
      className="eoy-row"
      aria-current={selected}
      onClick={() => onSelect(location.id)}
    >
      <span className="eoy-row__top">
        <span className="eoy-row__name">{location.name}</span>
        {/* Only ever rendered when there is a real origin. */}
        {distance === null ? null : <span className="eoy-row__distance">{distance}</span>}
      </span>
      <span className="eoy-row__address">{formatAddress(location)}</span>
      <span className="eoy-row__type">
        <span
          className={`eoy-legend-item__shape eoy-legend-item__shape--${style.shape}`}
          aria-hidden="true"
        />{' '}
        {describeType(location.type)} · {style.shapeDescription}
      </span>
    </button>
  );
}

export interface ViewToggleProps {
  readonly mode: 'map' | 'list';
  readonly onChange: (mode: 'map' | 'list') => void;
  readonly listCount: number;
}

type ViewMode = 'map' | 'list';

const VIEW_ORDER: readonly ViewMode[] = ['map', 'list'];

/**
 * A radiogroup, because it is a single choice between two peer views, and a radiogroup
 * gives the arrow-key navigation and the "1 of 2" announcement.
 *
 * THE ARROW KEYS ARE IMPLEMENTED HERE, not left to the browser, because `role="radio"` on a
 * `<button>` opts OUT of native radio behaviour and into the WAI-ARIA pattern — and the
 * WAI-ARIA pattern is the one that requires Arrow keys to move the selection. Without this
 * handler the group looked and announced like a radiogroup but did not behave like one,
 * which is worse than either extreme: a keyboard user tabs onto "Map", presses Right, and
 * nothing happens. Roving `tabindex` comes with it, so the pair is one tab stop rather than
 * two, which is what the pattern means by a radiogroup.
 */
export function ViewToggle({ mode, onChange, listCount }: ViewToggleProps): JSX.Element {
  const mapRef = useRef<HTMLButtonElement | null>(null);
  const listRef = useRef<HTMLButtonElement | null>(null);

  function move(next: ViewMode): void {
    onChange(next);
    (next === 'map' ? mapRef : listRef).current?.focus();
  }

  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>): void {
    const forward = event.key === 'ArrowRight' || event.key === 'ArrowDown';
    const back = event.key === 'ArrowLeft' || event.key === 'ArrowUp';
    if (!forward && !back) return;
    event.preventDefault();
    const index = VIEW_ORDER.indexOf(mode);
    const delta = forward ? 1 : -1;
    const next = VIEW_ORDER[(index + delta + VIEW_ORDER.length) % VIEW_ORDER.length];
    if (next !== undefined) move(next);
  }

  return (
    <div className="eoy-segmented" role="radiogroup" aria-label="Map or list view">
      <button
        type="button"
        role="radio"
        ref={mapRef}
        className="eoy-segmented__option"
        aria-checked={mode === 'map'}
        tabIndex={mode === 'map' ? 0 : -1}
        onClick={() => onChange('map')}
        onKeyDown={onKeyDown}
      >
        <MapIcon size={16} />
        Map
      </button>
      <button
        type="button"
        role="radio"
        ref={listRef}
        className="eoy-segmented__option"
        aria-checked={mode === 'list'}
        tabIndex={mode === 'list' ? 0 : -1}
        onClick={() => onChange('list')}
        onKeyDown={onKeyDown}
      >
        <ListIcon size={16} />
        List
        <span className="eoy-visually-hidden">, {formatBoroughCount(listCount)} available</span>
        {listCount > 0 ? (
          <span className="eoy-button__count" aria-hidden="true">
            {listCount > 999 ? '999+' : listCount}
          </span>
        ) : null}
      </button>
    </div>
  );
}
