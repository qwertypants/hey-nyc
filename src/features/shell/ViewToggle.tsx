/**
 * THE VIEW TOGGLE — map or list.
 *
 * Unchanged in behaviour, moved here because it is the shell's chrome and no longer has a
 * map-specific list component to live beside. The reasoning is preserved verbatim, and it is
 * the same reasoning the feature switcher uses, which is why the two look alike:
 *
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
 *
 * Public surface:
 *   ViewToggleProps, ViewToggle(props): JSX.Element
 */

import type { JSX, KeyboardEvent } from 'react';
import { useRef } from 'react';
import { formatPluralizedCount } from '../../lib/format';
import type { Nouns } from '../registry';
import { ListIcon, MapIcon } from '../../components/icons';

export type ViewMode = 'map' | 'list';

export interface ViewToggleProps {
  readonly mode: ViewMode;
  readonly onChange: (mode: ViewMode) => void;
  /** How many rows the list currently holds, in the active feature's noun. */
  readonly listCount: number;
  /** The active feature's noun, because "3 places available" and "114 count sites available" are different claims. */
  readonly nouns: Nouns;
}

const VIEW_ORDER: readonly ViewMode[] = ['map', 'list'];

export function ViewToggle({ mode, onChange, listCount, nouns }: ViewToggleProps): JSX.Element {
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
        <span className="eoy-visually-hidden">, {formatPluralizedCount(listCount, nouns.one, nouns.many)} available</span>
        {listCount > 0 ? (
          <span className="eoy-button__count" aria-hidden="true">
            {listCount > 999 ? '999+' : listCount}
          </span>
        ) : null}
      </button>
    </div>
  );
}
