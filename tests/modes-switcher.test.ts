/**
 * THE FEATURE SWITCHER, ON THE DARK HEADER.
 *
 * A regression suite for one bug, written because the bug survived 928 passing tests and was
 * only caught by looking at a screenshot.
 *
 * WHAT HAPPENED. The switcher's buttons carry BOTH `eoy-segmented__option` — the class the
 * bottom bar's "Map | List" pair uses, and which is written for a white surface — and
 * `eoy-modes__option`. That generic rule hard-codes `color: var(--eoy-text)`, and
 * `--eoy-text` is re-declared per colour SCHEME rather than per surface, so on the dark app
 * header it resolved to black. The UNSELECTED option was therefore black text on a black bar.
 * It was not dimmed, not clipped and not overlapped: it did not exist, and the switcher
 * appeared to offer one feature instead of two. A user could not switch to Where NYC Walks at
 * all without already knowing it was there.
 *
 * A second, quieter half of the same bug: the selected state in that generic rule is a BLACK
 * PILL, so on this surface the selection was also invisible. Even with the text fixed, nothing
 * would have said which of the two maps was open.
 *
 * WHY NO TEST CAUGHT IT. The component test asserts the switcher renders two radios and that
 * clicking one changes the feature. Both were true: the elements were in the DOM, the right
 * size, the right roles, and they worked. Everything that was wrong was paint, and jsdom does
 * not paint. A screenshot, by contrast, cannot help but show it.
 *
 * So these read the CASCADE rather than the DOM. For each state, resolve the declarations that
 * actually win, resolve the token the way a browser would, and assert the result is legible
 * on the header it sits on. That is the part under the stylesheet's control, which is the part
 * a well-meaning edit can quietly break.
 *
 * THE LIMIT, STATED UP FRONT. jsdom has no layout engine and no paint, so none of this can see
 * whether the text FITS. What it can see is which colour wins the cascade, and a specific,
 * checkable claim about that — which is the half of this bug that a stylesheet edit caused and
 * a stylesheet edit can therefore fix.
 */

import { describe, expect, it } from 'vitest';
import {
  CSS,
  CSS_NO_COMMENTS,
  cascadeFor,
  declarationsFor,
  resolve,
  specificity,
} from './helpers/stylesheet';
import type { Scheme } from './helpers/stylesheet';

/**
 * The schemes in which the header is a dark surface. `--eoy-text` is re-declared per scheme,
 * which is the mechanism the bug went through, so the check has to run wherever the header is
 * dark rather than in the light scheme alone.
 */
const DARK_SCHEMES: readonly Scheme[] = ['dark', 'enhanced dark'];

/**
 * The two states an option is ever in. `aria-checked` is what both the component and the
 * generic segmented rule key off, so these are the only states this stylesheet has.
 */
const STATES: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['unselected', []],
  ['selected', ['checked']],
];

/** 4.5:1 — WCAG 1.4.3 AA for body text. The switcher's label is the control's whole content. */
const AA_BODY = 4.5;

/** Relative luminance, from the WCAG definition. */
function luminance(hex: string): number {
  const channels = [1, 3, 5].map((offset) => {
    const value = parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!;
}

function contrast(foreground: string, background: string): number {
  const a = luminance(foreground);
  const b = luminance(background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

function isHex(value: string): boolean {
  return /^#[0-9a-f]{6}$/i.test(value.trim());
}

/**
 * The header's own background, read from the stylesheet rather than hard-coded.
 *
 * `.eoy-header` paints `#000000` with `#ffffff` text outright rather than through a token —
 * the one surface in this app that is unconditionally dark, because it is a photographic
 * backdrop for the wordmark rather than part of the reading surface. Reading it from the
 * rule means a change to the header's colour moves every threshold below with it.
 */
/** `.eoy-header`'s own text colour — what an `inherit`ing option resolves to. */
function headerInk(): string {
  const { color } = declarationsFor('dark', 'eoy-header');
  expect(color, '.eoy-header must declare a colour').toBeDefined();
  return color as string;
}

function headerSurface(): string {
  const { background } = declarationsFor('dark', 'eoy-header');
  expect(background, '.eoy-header must declare a background').toBeDefined();
  return background as string;
}

/** A custom property's declared value, from anywhere in the stylesheet. */
function declaredToken(name: string): string {
  const match = new RegExp(`--${name}:\\s*([^;]+);`).exec(CSS);
  if (match?.[1] === undefined) throw new Error(`--${name} is not declared in the stylesheet`);
  return match[1].trim();
}

describe('the feature switcher is legible on the dark header', () => {
  it.each(DARK_SCHEMES)('the option label is AA on the header in the %s scheme', (scheme) => {
    // The header surface, read from the stylesheet rather than hard-coded, so a change to
    // the header's own colour moves the threshold with it instead of silently invalidating
    // every number here.
    const surface = headerSurface();
    // The option's own `color` is `inherit`, so the pair under test is the header's colour
    // against the header's background. That is not a shortcut: `inherit` is the FIX, and
    // asserting a hex here would be asserting the bug. The generic segmented rule set a
    // token, and the token resolved to black on this surface — so what matters is that the
    // winning declaration defers to the parent rather than naming a colour of its own.
    for (const [name, state] of STATES) {
      const declared = cascadeFor('eoy-modes__option', state)['color'] ?? '';
      expect(declared, `${name}: expected the option to inherit, got ${declared}`).toBe('inherit');
      const ink = resolve(scheme, headerInk());
      expect(isHex(ink), `${name}: header ink ${ink} is not a hex value`).toBe(true);
      expect(
        contrast(ink, surface),
        `${name}: ${ink} on ${surface} is below ${AA_BODY}:1`,
      ).toBeGreaterThanOrEqual(AA_BODY);
    }
  });

  it('does not take the bottom bar\'s light-surface text colour', () => {
    // The precise regression, stated as a negative so the reason survives whoever deletes
    // this test. `--eoy-text` is black in the light scheme and the header is a dark surface;
    // taking the token without regard to the surface is what produced black-on-black.
    const declared = declarationsFor('dark', 'eoy-modes__option');
    expect(declared['color']).toBe('inherit');
  });

  it('beats the generic segmented rule on specificity, which is the whole fix', () => {
    // If this ever inverts, the generic rule wins again and the colour reverts to
    // `--eoy-text`'s black. Asserting the resolved colour is not enough on its own: this
    // names the mechanism, so a future edit that restores the bug with a different value
    // still fails here.
    const switcherRule = specificity('.eoy-modes .eoy-modes__option');
    const genericRule = specificity('.eoy-segmented__option');
    const [ids, classes] = switcherRule;
    const [genericIds, genericClasses] = genericRule;
    expect(ids).toBe(genericIds);
    expect(classes).toBeGreaterThan(genericClasses);
  });

  it('marks the selected option without a fill, which would be black on black', () => {
    const selected = cascadeFor('eoy-modes__option', ['checked']);
    // The generic rule's selected state is a black pill, invisible on this surface, so the
    // switcher declares a left rule in the text colour instead. Restoring the pill fails
    // here, which is the point: the pill is the bug.
    expect(selected['box-shadow']).toContain('inset');
    expect(selected['background-color']).not.toBe('#000000');
  });

  it('keeps the description one line, so two options cannot print on top of each other', () => {
    // At 390px the descriptions collided: each ran its full natural width into its
    // neighbour. `min-width: 0` is what lets the ellipsis engage, because a flex item
    // defaults to `min-width: auto` and refuses to shrink below its content.
    const declared = declarationsFor('dark', 'eoy-modes__description');
    expect(declared['text-overflow']).toBe('ellipsis');
    expect(declared['overflow']).toBe('hidden');
    expect(cascadeFor('eoy-modes__option', [])['min-width']).toBe('0');
  });

  it('sizes each option to its own label rather than to half the row', () => {
    // `flex: 1 1 auto` let each option absorb half the viewport; the pair stretched to
    // 1 414px at 1440px wide. Content sizing is what makes it read as a control.
    expect(cascadeFor('eoy-modes__option', [])['flex']).toBe('0 1 auto');
  });

  it('gives the switcher row a height the header can account for', () => {
    // `--eoy-header-height` is read by the detail sheet's max-height, so the modes row has
    // to be one of its terms or the sheet grows past the top of the viewport — which is
    // exactly what happened, and no test caught it, because it only shows on a screen.
    // The header height is a `calc()` of three row heights, one of which is the modes row.
    // If the modes row is dropped from that sum the detail sheet's max-height is short by a
    // whole row and the sheet's own title and close button open off the top of the screen —
    // which is what happened, and which no existing test could see.
    const modesHeight = declaredToken('eoy-modes-height');
    expect(modesHeight).toMatch(/rem$/);
    expect(declaredToken('eoy-header-height')).toContain('var(--eoy-modes-height)');
  });

  it('keeps every declaration the switcher depends on inside this stylesheet', () => {
    // The layout suite already refuses a `var(--token)` that nothing defines, but only for
    // tokens it walks. This asserts the switcher's own overrides are all present, so
    // deleting one of them is a failure here rather than a silent revert to the generic
    // rule's appearance.
    const source = CSS_NO_COMMENTS;
    for (const selector of [
      '.eoy-modes .eoy-modes__option',
      '.eoy-modes .eoy-modes__option[aria-checked=\'true\']',
    ]) {
      expect(source, `${selector} is missing from the stylesheet`).toContain(selector);
    }
  });
});
