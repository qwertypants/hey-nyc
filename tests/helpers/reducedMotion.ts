/**
 * The `matchMedia` double, and the switch that flips the motion preference for one test.
 *
 * jsdom has no `matchMedia` at all, so `tests/setup.ts` installs a stub that answers `false`
 * to everything — "motion allowed" is the right default, because it is the state the rest of
 * the suite was written against and it keeps a camera-move test from silently passing by
 * accident. What the default cannot express is the other state, so `stubPrefersReducedMotion`
 * re-stubs for a single test and `vi.unstubAllGlobals()` in the global `afterEach` puts the
 * default back for the next one.
 *
 * The stub reports `matches` only for the reduced-motion query. A blanket `true` would be a
 * lie that a later test could be fooled by: a viewport-width assertion would start "passing".
 *
 * Public surface:
 *   stubPrefersReducedMotion(reduced: boolean): void
 */

import { vi } from 'vitest';

/** By name rather than by exact query text, so a `(prefers-reduced-motion: no-preference)` also answers. */
const REDUCED_MOTION_FEATURE = 'prefers-reduced-motion';

function mediaQueryList(query: string, reduced: boolean): MediaQueryList {
  return {
    matches: reduced && query.includes(REDUCED_MOTION_FEATURE),
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  };
}

export function stubPrefersReducedMotion(reduced: boolean): void {
  vi.stubGlobal(
    'matchMedia',
    vi.fn().mockImplementation((query: string) => mediaQueryList(query, reduced)),
  );
}
