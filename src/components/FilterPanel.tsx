/**
 * Two filters. Not a drawer.
 *
 * The dataset has exactly two filterable dimensions that matter to the question the app
 * answers: what kind of outdoor dining, and which borough. Everything else in the source —
 * council district, community board, NTA, BIN, BBL — has no honest user-facing question
 * attached to it (docs/data-dictionary.md §2), so it is not here.
 *
 * Choices:
 * - Real `<input type="radio">` inside a `<fieldset>` with a `<legend>`. Radios give the
 *   group name for free, give arrow-key navigation for free, and announce "1 of 4". A grid
 *   of toggle buttons would need all three re-implemented by hand and would still be wrong
 *   for a screen reader.
 * - Every option carries its COUNT, and an option that would yield zero results is
 *   `disabled` and says so — so the user learns that "Roadway + Staten Island" is empty
 *   before they tap it, not after. The currently selected option is never disabled: you
 *   must always be able to select what you already have selected, and to select "All" to
 *   escape.
 * - The counts are computed with the OTHER dimension held at its current value, which is
 *   what `typeOptions` / `boroughOptions` in `src/lib/filters.ts` already do. One
 *   definition, shared with the map's `setFilter` expression, so the badge can never lie.
 * - Wording for the dining types comes from `describeType` in `src/map/style.ts`, the same
 *   string the map's own labels and the detail sheet use.
 *
 * It is a NON-MODAL popover: Escape closes it, focus returns to the button that opened it,
 * and Tab is allowed to leave (see `useFocusTrap`). The list view is the accessible
 * alternative to the map and must never be sealed off behind an open panel.
 */

import type { JSX } from 'react';
import { useId, useRef } from 'react';
import type { BoroughFilter, FilterOption, Filters, TypeFilter } from '../lib/filters';
import { countFor, isFiltered } from '../lib/filters';
import { describeType } from '../map/style';
import { BOROUGHS, DINING_TYPES } from '../types/location';
import type { LocationProperties } from '../types/location';
import { useFocusTrap } from '../hooks/useFocusTrap';
import { CloseIcon, FilterIcon } from './icons';

/**
 * The option lists, built here rather than with `typeOptions` / `boroughOptions` from
 * `src/lib/filters.ts` — because those put the TOTAL dataset size in the "All" label while
 * the count column then shows the FILTERED size, so the same row reads "All (2 000) · 396".
 * One number per row, computed by the same `countFor` the map's filter expression implies:
 * the candidate option against the other dimension held at its current value.
 */
function typeChoicesFor(
  locations: readonly LocationProperties[],
  filters: Filters,
): FilterOption<TypeFilter>[] {
  const values: TypeFilter[] = ['all', ...DINING_TYPES];
  return values.map((value) => {
    const count = countFor(locations, { type: value, borough: filters.borough });
    return {
      value,
      label: value === 'all' ? 'All types' : describeType(value),
      count,
      empty: count === 0,
    };
  });
}

function boroughChoicesFor(
  locations: readonly LocationProperties[],
  filters: Filters,
): FilterOption<BoroughFilter>[] {
  const values: BoroughFilter[] = ['all', ...BOROUGHS];
  return values.map((value) => {
    const count = countFor(locations, { type: filters.type, borough: value });
    return {
      value,
      label: value === 'all' ? 'All boroughs' : value,
      count,
      empty: count === 0,
    };
  });
}

export interface FilterPanelProps {
  readonly open: boolean;
  readonly locations: readonly LocationProperties[];
  readonly filters: Filters;
  readonly onChange: (filters: Filters) => void;
  readonly onClose: () => void;
  /** Stable id so the header button's `aria-controls` always points at a real element. */
  readonly panelId: string;
}

export function FilterPanel({
  open,
  locations,
  filters,
  onChange,
  onClose,
  panelId,
}: FilterPanelProps): JSX.Element {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  const headingId = useId();
  const typeName = useId();
  const boroughName = useId();

  // Non-modal: focus lands on the heading so "Filters" is announced, and Tab is free to
  // leave the panel and reach the list. The point of this app is that the list is a
  // first-class alternative to the map, not something behind a popover.
  useFocusTrap(panelRef, { active: open, onEscape: onClose, trap: false, initialFocus: headingRef });

  const typeChoices = typeChoicesFor(locations, filters);
  const boroughChoices = boroughChoicesFor(locations, filters);

  // The wrapper is always in the DOM so `aria-controls` never dangles; the panel itself
  // only mounts when open, which is what keeps the focus effect cheap.
  return (
    <div className="eoy-filters-wrap" id={panelId} hidden={!open}>
      {open ? (
        <div
          className="eoy-filters"
          role="group"
          aria-labelledby={headingId}
          ref={panelRef}
          data-testid="filter-panel"
        >
          <h2 className="eoy-filters__heading" id={headingId} ref={headingRef} tabIndex={-1}>
            Filters
          </h2>

          <fieldset className="eoy-filters__group">
            <legend className="eoy-filters__legend">Dining type</legend>
            {typeChoices.map((option) => (
              <label className="eoy-filters__option" key={option.value}>
                <input
                  type="radio"
                  name={typeName}
                  value={option.value}
                  checked={filters.type === option.value}
                  disabled={option.empty && filters.type !== option.value}
                  onChange={() => onChange({ ...filters, type: option.value as TypeFilter })}
                />
                <span className="eoy-filters__label">{option.label}</span>
                <span className="eoy-filters__count">
                  {option.empty ? 'none' : option.count.toLocaleString('en-US')}
                </span>
              </label>
            ))}
          </fieldset>

          <fieldset className="eoy-filters__group">
            <legend className="eoy-filters__legend">Borough</legend>
            {boroughChoices.map((option) => (
              <label className="eoy-filters__option" key={option.value}>
                <input
                  type="radio"
                  name={boroughName}
                  value={option.value}
                  checked={filters.borough === option.value}
                  disabled={option.empty && filters.borough !== option.value}
                  onChange={() => onChange({ ...filters, borough: option.value as BoroughFilter })}
                />
                <span className="eoy-filters__label">{option.label}</span>
                <span className="eoy-filters__count">
                  {option.empty ? 'none' : option.count.toLocaleString('en-US')}
                </span>
              </label>
            ))}
          </fieldset>

          <div className="eoy-filters__actions">
            <button
              type="button"
              className="eoy-button eoy-button--small"
              onClick={() => onChange({ type: 'all', borough: 'all' })}
              disabled={!isFiltered(filters)}
            >
              Clear
            </button>
            <button
              type="button"
              className="eoy-button eoy-button--small eoy-button--primary"
              onClick={onClose}
            >
              <CloseIcon size={14} />
              Done
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** The header's toggle. Exported so App can own the trigger and the panel stays dumb. */
export interface FiltersButtonProps {
  readonly open: boolean;
  readonly disabled: boolean;
  readonly activeCount: number;
  readonly onToggle: () => void;
  readonly controls: string | undefined;
}

export function FiltersButton({
  open,
  disabled,
  activeCount,
  onToggle,
  controls,
}: FiltersButtonProps): JSX.Element {
  return (
    <button
      type="button"
      className="eoy-button eoy-button--on-dark"
      onClick={onToggle}
      disabled={disabled}
      aria-expanded={open}
      aria-controls={controls}
    >
      <FilterIcon />
      <span>Filters</span>
      {activeCount > 0 ? (
        <span className="eoy-button__count" aria-hidden="true">
          {activeCount}
        </span>
      ) : null}
      <span className="eoy-visually-hidden">
        {activeCount > 0 ? `, ${activeCount} active` : ''}
      </span>
    </button>
  );
}
