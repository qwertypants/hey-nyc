/**
 * INTEGRATION NOTES (src/features/walk/WalkSortControl.tsx)
 *
 * The three sort controls, with each sort's DEFINITION printed under its label.
 *
 * WHY THE DEFINITION IS ON SCREEN AND NOT IN A TOOLTIP
 * ---------------------------------------------------
 * "Busiest", "Changed the most" and "Nearest" are three different claims about the same 114
 * sites, and a reader who cannot see the definition of the one they are looking at has no way
 * to know they are looking at the most recent survey rather than a lifetime average, or at the
 * largest absolute move rather than the biggest rise. A tooltip is invisible on a touch
 * screen, unavailable to a keyboard user without an extra tab stop, and read by nobody who
 * has already tapped the control.
 *
 * So the definition is a `<span>` inside the label of every radio, which means:
 *   - it is in the accessible NAME, so a screen reader announces the claim as part of the
 *     control rather than as a separate thing to go and find;
 *   - it is visible to everyone, without a hover;
 *   - `aria-describedby` is not needed, so there is one name per control and no chance of the
 *     two disagreeing.
 *
 * `nearby` IS REFUSED WITHOUT A POSITION, and the refusal is explicit. A radio that cannot
 * answer is not rendered as a disabled radio inside a group the visitor can still submit; it
 * is not rendered at all, and the group says why in text. A disabled control invites a
 * question the app cannot answer, and the question is "why can't I sort by distance?" — which
 * deserves "because we do not know where you are" as words, not as a greyed-out button.
 *
 * RADIOS, NOT BUTTONS. Three mutually exclusive orders of ONE list is exactly what a radio
 * group is, and it gives arrow-key navigation and a single tab stop for free. Three buttons
 * would be three tab stops and no announced relationship between them.
 *
 * Public surface:
 *   WalkSortControl, WalkSortControlProps
 */

import type { JSX } from 'react';
import { useId } from 'react';
import type { WalkSort } from '../registry';
import { WALK_SORT_OPTIONS } from './rows';
import type { WalkSortOption } from './rows';

export interface WalkSortControlProps {
  /** The current sort, or null when the shell has not chosen one. */
  readonly sort: WalkSort | null;
  /** The visitor's position, or null. The only legal reason a `nearby` sort can exist. */
  readonly origin: { readonly lat: number; readonly lng: number } | null;
  readonly onChange: (sort: WalkSort) => void;
  /** The `mostSurveyed` default, applied when the shell has no sort yet. */
  readonly defaultSort?: WalkSort;
}

const NO_POSITION_NOTE =
  'Distance is not offered here because the app does not have your position. Use “Near me” in the header to share it once; it is never stored and never added to this page’s address.';

export function WalkSortControl({
  sort,
  origin,
  onChange,
  defaultSort = 'mostSurveyed',
}: WalkSortControlProps): JSX.Element {
  const groupName = useId();
  const options: readonly WalkSortOption[] = WALK_SORT_OPTIONS.filter(
    (option) => option.needsPosition === false || origin !== null,
  );
  const selected = sort ?? defaultSort;

  return (
    <fieldset className="wnyc-sort">
      <legend className="wnyc-sort__legend">Order the list</legend>

      {origin === null ? <p className="wnyc-sort__note">{NO_POSITION_NOTE}</p> : null}

      {/*
        A `<fieldset>` with a real `<legend>`, so the group has a name rather than an
        `aria-label` bolted onto a `<div>`. Nothing here is `disabled` — see the module header
        for why a control that cannot answer is not rendered at all.
      */}
      <div className="wnyc-sort__options" role="radiogroup" aria-label="Order the list">
        {options.map((option) => {
          const id = `${groupName}-${option.id}`;
          return (
            <div className="wnyc-sort__option" key={option.id}>
              <input
                className="wnyc-sort__input eoy-visually-hidden"
                type="radio"
                id={id}
                name={groupName}
                value={option.id}
                checked={selected === option.id}
                onChange={() => {
                  onChange(option.id);
                }}
              />
              <label className="wnyc-sort__label" htmlFor={id}>
                <span className="wnyc-sort__name">{option.label}</span>
                <span className="wnyc-sort__definition">{option.definition}</span>
              </label>
            </div>
          );
        })}
      </div>
    </fieldset>
  );
}
