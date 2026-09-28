/**
 * THE FILTER RAIL. The app's primary control, on screen at all times.
 *
 * WHY THIS REPLACED A POPOVER. A "Filters" button that opens a panel two taps deep is a
 * control the visitor has to know exists. The two dimensions this dataset can be filtered on
 * — what kind of outdoor dining, and which borough — are 4 and 6 options respectively. Both
 * fit in a row of pills. There was never a reason to hide ten answers behind a disclosure,
 * and hiding them meant the app's most consequential decision was invisible: you could not
 * see, at a glance, that you were looking at roadway dining only, or that the map had been
 * narrowed to Staten Island.
 *
 * So the rail is a single horizontally scrollable strip under the search bar, always
 * visible, in the order people actually decide: type first, then place. It scrolls rather
 * than wraps because a wrapping rail changes the header height, which resizes the map, and
 * a map that resizes when you pick a filter loses your place.
 *
 * SEMANTICS. Real `<fieldset>` + `<legend>` + real `<input type="radio">`, exactly as the
 * popover did, and for the same reasons: the group name is announced, arrow keys navigate,
 * and "2 of 4" comes for free. The only change is the visual skin — a pill instead of a row.
 * Nothing about the semantics was traded away to get the pills.
 *
 * COUNTS. Every chip carries the number of places it would yield, computed with the OTHER
 * dimension held at its current value — the same `countFor` the map's own `setFilter`
 * expression implies, so the badge cannot disagree with the result. A chip that would yield
 * nothing is `disabled` and says "none", so "Roadway + Staten Island" is discoverable as
 * empty before it is tapped, not after. The currently selected chip is never disabled: you
 * must always be able to re-select what you have, and to select "All" to escape.
 *
 * COLOUR IS NEVER THE ONLY SIGNAL. A selected chip inverts to black-on-white exactly like
 * the design system's other active states, and it is the only chip in its group that is
 * inverted, so the position in the row already carries the meaning.
 *
 * Public surface:
 *   FilterRail(props): JSX.Element
 */

import type { JSX } from 'react';
import type { BoroughFilter, Filters, TypeFilter } from '../../lib/filters';
import { countFor, isFiltered } from '../../lib/filters';
import { describeType } from '../../map/style';
import { BOROUGHS, DINING_TYPES } from '../../types/location';
import type { LocationProperties } from '../../types/location';

export interface FilterRailProps {
  readonly locations: readonly LocationProperties[];
  readonly filters: Filters;
  readonly onChange: (filters: Filters) => void;
  /** Disabled until the dataset is ready, so the counts can never show a stale zero. */
  readonly disabled: boolean;
}

export function FilterRail({ locations, filters, onChange, disabled }: FilterRailProps): JSX.Element {
  const typeValues: readonly TypeFilter[] = ['all', ...DINING_TYPES];
  const boroughValues: readonly BoroughFilter[] = ['all', ...BOROUGHS];

  return (
    <div className="eoy-rail" data-testid="filter-rail">
      <div className="eoy-rail__scroll">
        <fieldset className="eoy-rail__group" disabled={disabled}>
          <legend className="eoy-rail__legend">Dining type</legend>
          <div className="eoy-rail__chips">
            {typeValues.map((value) => {
              const count = countFor(locations, { type: value, borough: filters.borough });
              return (
                <Chip
                  key={value}
                  name="eoy-filter-type"
                  value={value}
                  label={value === 'all' ? 'All' : describeType(value)}
                  count={count}
                  checked={filters.type === value}
                  empty={count === 0}
                  onSelect={() => onChange({ ...filters, type: value })}
                />
              );
            })}
          </div>
        </fieldset>

        <span className="eoy-rail__divider" aria-hidden="true" />

        <fieldset className="eoy-rail__group" disabled={disabled}>
          <legend className="eoy-rail__legend">Borough</legend>
          <div className="eoy-rail__chips">
            {boroughValues.map((value) => {
              const count = countFor(locations, { type: filters.type, borough: value });
              return (
                <Chip
                  key={value}
                  name="eoy-filter-borough"
                  value={value}
                  label={value === 'all' ? 'All' : value}
                  count={count}
                  checked={filters.borough === value}
                  empty={count === 0}
                  onSelect={() => onChange({ ...filters, borough: value })}
                />
              );
            })}
          </div>
        </fieldset>
      </div>

      {isFiltered(filters) ? (
        <button
          type="button"
          className="eoy-rail__clear"
          disabled={disabled}
          onClick={() => onChange({ type: 'all', borough: 'all' })}
        >
          Clear filters
        </button>
      ) : null}
    </div>
  );
}

interface ChipProps {
  readonly name: string;
  readonly value: string;
  readonly label: string;
  readonly count: number;
  readonly checked: boolean;
  readonly empty: boolean;
  readonly onSelect: () => void;
}

function Chip({ name, value, label, count, checked, empty, onSelect }: ChipProps): JSX.Element {
  return (
    <label className="eoy-chip">
      <input
        type="radio"
        name={name}
        value={value}
        checked={checked}
        disabled={empty && !checked}
        onChange={onSelect}
      />
      <span className="eoy-chip__label">{label}</span>
      <span className="eoy-chip__count" aria-hidden="true">
        {empty ? 'none' : count.toLocaleString('en-US')}
      </span>
      {/*
        The count is a real datum, not decoration, so it is in the accessible name too —
        once, in words. It is NOT read off the badge above, because a badge is a number with
        no unit: "Roadway dining 2" invites the reader to wonder 2 of what. The em dash keeps
        the sentence readable when the count is skipped, and "none" is spoken as a phrase
        rather than as a stray word.
      */}
      <span className="eoy-visually-hidden">
        {empty ? ' — no places match' : ` — ${count.toLocaleString('en-US')} places`}
      </span>
    </label>
  );
}
