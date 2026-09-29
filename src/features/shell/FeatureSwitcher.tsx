/**
 * THE FEATURE SWITCHER.
 *
 * A segmented control in the header, above the search box, in its own row. Three reasons it
 * is there and not somewhere cleverer:
 *
 *   - IT IS ALWAYS THERE. A feature hidden behind a menu is a feature most visitors will not
 *     find, and this is a two-way choice with consequences for the whole page — the map, the
 *     list, the filters and the data all change. It belongs where the thing it changes is.
 *
 *   - IT IS ABOVE THE FOLD, NOT BELOW THE THUMB. On a phone the bottom of the screen is
 *     where a thumb is and the top of the screen is where a menu is. The map/list toggle
 *     already owns the bottom bar, so the mode lives in the header; the alternative — a third
 *     control in the floating bar — would make the bar a wall on a 390px phone. It is on
 *     screen in BOTH views, because the header is on screen in both views, and it is a
 *     44px-tall target in the same design system as every other control.
 *
 *   - IT IS A RADIOGROUP, and the arrow keys are implemented. For the same reason
 *     `ViewToggle` implements them (src/features/shell/ViewToggle.tsx): `role="radio"` on a
 *     `<button>` opts out of native radio behaviour and into the WAI-ARIA pattern, and the
 *     pattern requires Arrow keys to move the selection. A group that announced as a
 *     radiogroup and did not behave like one is worse than two loose buttons. Roving
 *     `tabindex` comes with it, so the pair is one tab stop.
 *
 * The selected feature's DESCRIPTION is in the accessible name of its own option, after the
 * label, so a screen-reader user learns what the other one is before pressing it — and the
 * current one, which is the cheapest possible confirmation that the press did something.
 *
 * Public surface:
 *   FeatureSwitcher(props): JSX.Element
 */

import type { JSX, KeyboardEvent } from 'react';
import { useRef } from 'react';
import type { FeatureId, FeatureIdentity } from '../registry';

export interface FeatureSwitcherProps {
  readonly features: readonly FeatureIdentity[];
  readonly selected: FeatureId;
  readonly onSelect: (id: FeatureId) => void;
  /**
   * True once the ACTIVE feature's data has resolved. While it is false the whole group is
   * disabled, because a switch to a feature that cannot load would replace a working map with
   * an empty one — and because a chip showing a count it cannot compute is the same lie
   * `FilterRail` avoids.
   */
  readonly disabled: boolean;
}

export function FeatureSwitcher({
  features,
  selected,
  onSelect,
  disabled,
}: FeatureSwitcherProps): JSX.Element {
  const buttons = useRef(new Map<FeatureId, HTMLButtonElement>());

  const focusOption = (id: FeatureId): void => {
    buttons.current.get(id)?.focus();
  };

  function move(delta: number): void {
    const index = features.findIndex((feature) => feature.id === selected);
    const next = features[(index + delta + features.length) % features.length];
    if (next === undefined) return;
    onSelect(next.id);
    focusOption(next.id);
  }

  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>): void {
    const forward = event.key === 'ArrowRight' || event.key === 'ArrowDown';
    const back = event.key === 'ArrowLeft' || event.key === 'ArrowUp';
    if (!forward && !back) return;
    event.preventDefault();
    move(forward ? 1 : -1);
  }

  return (
    <div className="eoy-modes" role="radiogroup" aria-label="Map feature" data-testid="feature-switcher">
      {features.map((feature) => {
        const active = feature.id === selected;
        return (
          <button
            key={feature.id}
            type="button"
            role="radio"
            aria-checked={active}
            className="eoy-segmented__option eoy-modes__option"
            tabIndex={active ? 0 : -1}
            disabled={disabled}
            data-feature={feature.id}
            ref={(element: HTMLButtonElement | null) => {
              if (element === null) buttons.current.delete(feature.id);
              else buttons.current.set(feature.id, element);
            }}
            onClick={() => onSelect(feature.id)}
            onKeyDown={onKeyDown}
          >
            <span className="eoy-modes__label">{feature.label}</span>
            <span className="eoy-modes__description">{feature.description}</span>
          </button>
        );
      })}
    </div>
  );
}
