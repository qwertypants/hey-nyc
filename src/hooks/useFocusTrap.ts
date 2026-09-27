/**
 * Focus management for the two overlays the app has.
 *
 * Both need the same three things — move focus in, close on Escape, put focus back where
 * it came from — and they differ in exactly one: whether Tab is contained.
 *
 * - The detail sheet is a modal bottom sheet. The rest of the app is marked `inert` while
 *   it is open, so Tab MUST be contained; without it, Tab would walk into an inert subtree
 *   and the focus ring would appear to vanish.
 * - The filter panel is a NON-modal popover. Tab is deliberately NOT contained: the list
 *   right below it is the app's accessible alternative to the map, and a keyboard user
 *   must be able to Tab straight out of the panel into it.
 *
 * On close, focus returns to whatever was focused before, provided it is still in the
 * document. If it is not (a list row that has been unmounted by a filter change, say) the
 * browser's own fallback applies rather than this hook inventing a target.
 *
 * Public surface:
 *   FOCUSABLE_SELECTOR
 *   useFocusTrap(ref, options): void
 */

import { useEffect, useRef } from 'react';
import type { RefObject } from 'react';

export const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

export interface FocusTrapOptions {
  readonly active: boolean;
  /** Escape closes the overlay. Omit when the overlay is not dismissible. */
  readonly onEscape?: () => void;
  /** Where focus lands on open. Defaults to the first focusable descendant. */
  readonly initialFocus?: RefObject<HTMLElement | null>;
  /** Contain Tab inside the container. True only for genuinely modal overlays. */
  readonly trap?: boolean;
}

function focusableWithin(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)].filter(
    (element) => element.getAttribute('aria-hidden') !== 'true' && element.tabIndex >= 0,
  );
}

export function useFocusTrap(
  ref: RefObject<HTMLElement | null>,
  options: FocusTrapOptions,
): void {
  const { active, trap = true } = options;
  const onEscape = options.onEscape;
  const initialFocus = options.initialFocus;

  // Refs, not dependencies: a caller that passes an inline arrow must not re-run the
  // open/close cycle (and steal focus) on every render.
  const onEscapeRef = useRef(onEscape);
  onEscapeRef.current = onEscape;
  const initialFocusRef = useRef(initialFocus);
  initialFocusRef.current = initialFocus;

  useEffect(() => {
    if (!active) return;
    const container = ref.current;
    if (container === null) return;

    const previous =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;

    const target = initialFocusRef.current?.current ?? focusableWithin(container)[0] ?? container;
    // `preventScroll` keeps the sheet's open from yanking the list to the bottom on iOS.
    target.focus({ preventScroll: true });

    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        onEscapeRef.current?.();
        return;
      }
      if (event.key !== 'Tab' || !trap) return;

      const focusable = focusableWithin(container);
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (first === undefined || last === undefined) {
        event.preventDefault();
        container.focus({ preventScroll: true });
        return;
      }

      const activeElement = document.activeElement;
      // Focus already escaped the container: pull it back to the first stop rather than
      // letting it wander into the inert background.
      if (activeElement === null || !container.contains(activeElement)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus({ preventScroll: true });
        return;
      }

      if (event.shiftKey && activeElement === first) {
        event.preventDefault();
        last.focus({ preventScroll: true });
        return;
      }
      if (!event.shiftKey && activeElement === last) {
        event.preventDefault();
        first.focus({ preventScroll: true });
      }
    };

    container.addEventListener('keydown', handleKeyDown);
    return () => {
      container.removeEventListener('keydown', handleKeyDown);
      if (previous !== null && previous.isConnected) {
        previous.focus({ preventScroll: true });
      }
    };
  }, [active, ref, trap]);
}
