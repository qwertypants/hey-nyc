/**
 * LAYOUT RESILIENCE. The three WCAG success criteria that are about the box rather than the
 * colour, and that no other suite in this repo can check: target size (2.5.8), text spacing
 * (1.4.12) and reflow (1.4.10).
 *
 * All three were previously comments in `src/index.css` — a promise with nothing behind it.
 * They are promises a sighted developer can keep by accident for a while and then break with
 * one well-meant `height: 44px`, and the breakage is invisible in a screenshot and invisible
 * to the person making it. So they are checked here instead.
 *
 * THE LIMIT, STATED UP FRONT: jsdom has no layout engine. These suites read the declarations
 * rather than the rendered box, so they can prove "this control was given at least 24px of
 * min-height" but not "the text fits inside it". That is a real gap and it is why the checks
 * are written to be conservative — they assert the DECLARATION is safe, which is the part
 * under the author's control, and they fail on the shapes that make overflow likely rather
 * than pretending to have measured the result.
 */

import { describe, expect, it } from 'vitest';
import {
  CSS_NO_COMMENTS,
  declarationsFor,
  elementDeclarations,
  lengthsToPx,
  readBlocks,
  resolve,
  ruleAppliesTo,
} from './helpers/stylesheet';

/** WCAG 2.2 SC 2.5.8 Target Size (Minimum), level AA. */
const MIN_TARGET_PX = 24;
/** The floor 2.5.5 sets at AAA, and the size the design system uses as its default. */
const TARGET_PX = 44;

/**
 * Every class that ends up on something a pointer or a keyboard lands on. Kept as a list
 * rather than derived, because "is this selector interactive" is a judgement, and a judgement
 * hidden inside a heuristic is a judgement nobody can audit later.
 */
/**
 * Modifiers, and the base class whose size they inherit. `.eoy-button--primary` sets only
 * colours; its 44px comes from `.eoy-button`. Asserting the modifier on its own would fail on
 * correct code, so the base is named here rather than letting the audit be quietly weakened.
 */
const INHERITS: Readonly<Record<string, string>> = {
  'eoy-button--primary': 'eoy-button',
  'eoy-button--ghost': 'eoy-button',
  'eoy-pill--primary': 'eoy-pill',
  'eoy-pill--on-dark': 'eoy-pill',
};

const INTERACTIVE = [
  'eoy-skip-link',
  'eoy-pill',
  'eoy-button',
  'eoy-button--tight',
  'eoy-button--primary',
  'eoy-button--ghost',
  'eoy-chip',
  'eoy-rail__clear',
  'eoy-search__field',
  'eoy-search__input',
  'eoy-search__clear',
  'eoy-search__submit',
  'eoy-search__option',
  'eoy-row',
  'eoy-legend__summary',
  'eoy-sheet__close',
  'eoy-segmented__option',
] as const;

describe('target size (WCAG 2.2 SC 2.5.8, AA)', () => {
  for (const name of INTERACTIVE) {
    it(`.${name} declares a target of at least ${MIN_TARGET_PX}px`, () => {
      const base = INHERITS[name];
      const declarations = {
        ...(base === undefined ? {} : declarationsFor('light', base)),
        ...declarationsFor('light', name),
      };
      // The input inside a chip is a deliberate 1px sliver; the CHIP is the target, and the
      // rule for it is `.eoy-chip`. Guard the name is real so a typo cannot pass by matching
      // nothing.
      expect(
        Object.keys(declarations).length,
        `.${name} has no rules at all, so this assertion proves nothing`,
      ).toBeGreaterThan(0);

      const minHeight = declarations['min-height'];
      const height = declarations['height'];
      const minWidth = declarations['min-width'];
      const width = declarations['width'];
      const paddingBlock = declarations['padding'];

      const candidates = [minHeight, height].filter((v): v is string => v !== undefined);
      expect(
        candidates.length,
        `.${name} sets neither height nor min-height, so its size is whatever its content happens to be`,
      ).toBeGreaterThan(0);

      for (const candidate of candidates) {
        const px = lengthsToPx('light', candidate);
        if (px === null) continue; // e.g. `calc()` this helper cannot fold
        expect(px, `.${name} resolves to ${px}px, under the ${MIN_TARGET_PX}px floor`).toBeGreaterThanOrEqual(
          MIN_TARGET_PX,
        );
      }

      /*
       * A control that is tall but only as wide as its text still needs a width floor.
       *
       * `min-width: 0` is excluded, and deliberately so: it is a flex SHRINK ALLOWANCE, not a
       * size. The search field and its input both declare it, because they are the two things
       * that must be allowed to give way on a narrow phone. Reading it as a width of 0px
       * reported both as un-clickable, which is the opposite of the truth — they are the two
       * most elastic elements in the layout, and the reflow suite below depends on it.
       */
      for (const candidate of [minWidth, width].filter((v): v is string => v !== undefined)) {
        const px = lengthsToPx('light', candidate);
        if (px === null || px === 0) continue;
        expect(px, `.${name} width resolves to ${px}px, under the ${MIN_TARGET_PX}px floor`).toBeGreaterThanOrEqual(
          MIN_TARGET_PX,
        );
      }
      void paddingBlock;
    });
  }

  it('the design system default really is the 44px AAA floor', () => {
    // Every one of the 2.5.8 assertions above can pass while the default silently drops to
    // 28px, so the token itself is pinned.
    expect(lengthsToPx('light', 'var(--eoy-tap)')).toBe(TARGET_PX);
  });

  it('the pill controls the design system calls 44px actually use the token, not a literal', () => {
    // A hard-coded 44 in one place and a token in another is how the two drift.
    // `ruleAppliesTo` rather than a regex over the selector: `.eoy-chip input` contains the
    // characters ".eoy-chip" but styles the INPUT, not the chip, so a substring test flagged
    // the 1px screen-reader sliver as a pill hard-coding a pixel size.
    const PILL_CLASSES = ['eoy-pill', 'eoy-chip', 'eoy-rail__clear'];
    const hardCoded = readBlocks().filter(
      (b) =>
        PILL_CLASSES.some((c) => ruleAppliesTo(b.selector, c)) &&
        /(^|[;{\s])(min-)?height:\s*[\d.]+px/.test(b.body) &&
        !/var\(--eoy-tap\)/.test(b.body),
    );
    expect(
      hardCoded.map((b) => `${b.selector} -> ${b.body.trim().replace(/\s+/g, ' ')}`),
      'these pill rules hard-code a pixel size instead of using --eoy-tap',
    ).toEqual([]);
  });
});

describe('text spacing (WCAG 2.2 SC 1.4.12, AA)', () => {
  /**
   * 1.4.12 asks that a user can override line-height to 1.5x, paragraph spacing to 2x,
   * letter-spacing to 0.12em and word-spacing to 0.16em and the content still survives. The
   * two declarations that break that are a fixed `height` on something that contains text, and
   * `overflow: hidden` on the same thing. Both are checked.
   */
  /*
   * The allowlist, with the reason each fixed height is safe. An allowlist rather than a
   * heuristic, because "this box contains no text" is not something CSS can tell us — and a
   * heuristic that guesses wrong produces a test people learn to ignore. Every entry here has
   * been looked at. A NEW fixed height fails, which is the point.
   */
  const SAFE_FIXED_HEIGHTS: Readonly<Record<string, string>> = {
    'eoy-visually-hidden': 'screen-reader-only by definition; 1px is the whole mechanism',
    'eoy-chip input': 'the visually-hidden radio inside a chip; the chip is the target',
    'eoy-type-list__check': 'a decorative check badge with an aria-hidden SVG in it, no text',
    'eoy-legend-item__shape': 'a data swatch; the type is named in words beside it',
    'eoy-wordmark__mark': 'the wordmark glyph, aria-hidden, no text',
    'eoy-user-chip__dot': 'a 0.7rem dot next to the words "Using your location"',
    'eoy-user-marker': 'the MapLibre marker element; it is an image, not text',
    'eoy-skeleton': 'a loading shimmer bar, aria-hidden, no text',
    'eoy-sheet__grip': 'the decorative drag affordance, aria-hidden',
  };

  it('no text-bearing rule sets a fixed height', () => {
    const offenders = readBlocks()
      .filter((b) => /(^|[;{\s])height\s*:\s*[\d.]+(px|rem)/.test(b.body))
      .filter((b) => !/max-height/.test(b.body))
      /*
       * Matched against the rule's own selector text, not through `ruleAppliesTo`. Three of
       * these entries are not bare classes — `.eoy-chip input` is a compound selector, and the
       * three swatches are `.eoy-legend-item__shape--disc` / `--rimmed-disc` / `--ring`, which
       * a class-token test correctly refuses to match to their shared base name. The entries
       * are specific enough that matching the selector text is not over-broad: naming
       * `.eoy-legend-item__shape` covers all three variants, which is the intent.
       */
      .filter((b) => !Object.keys(SAFE_FIXED_HEIGHTS).some((name) => b.selector.includes(name)))
      .map((b) => `${b.selector} { ${b.body.trim().replace(/\s+/g, ' ')} }`);
    expect(
      offenders,
      `these rules fix a height and can clip text when a user increases line-height. If one is\n` +
        `genuinely safe, add it to SAFE_FIXED_HEIGHTS with the reason:\n  ${offenders.join('\n  ')}`,
    ).toEqual([]);
  });

  it('every allowlisted fixed height is still there, so an exemption cannot outlive its rule', () => {
    // Otherwise a class can be deleted from the component tree, or emptied of its fixed
    // height, while its exemption sits quietly in this file making the test above look
    // thorough. Keyed off the rules themselves rather than off the class, because two entries
    // name a compound selector (`.eoy-chip input`) rather than a bare class.
    for (const [name, reason] of Object.entries(SAFE_FIXED_HEIGHTS)) {
      const found = readBlocks().some(
        (b) =>
          b.selector.includes(name) &&
          /(^|[;{\s])height\s*:\s*[\d.]+(px|rem)/.test(b.body),
      );
      expect(
        found,
        `${name} is exempt from the fixed-height rule ("${reason}") but no rule sets a height on it. ` +
          'Remove it from the allowlist.',
      ).toBe(true);
    }
  });

  it('no control clips its own label', () => {
    const offenders = readBlocks()
      .filter((b) => /overflow:\s*hidden/.test(b.body) && /\bheight\s*:/.test(b.body))
      .filter((b) => /clip-path|inset\(50%\)|\.eoy-visually-hidden/.test(b.selector + b.body) === false)
      .map((b) => `${b.selector} { ${b.body.trim().replace(/\s+/g, ' ')} }`);
    expect(offenders, `these rules clip vertically with a fixed height:\n  ${offenders.join('\n  ')}`).toEqual([]);
  });

  it('the visually-hidden utility cannot be broken into hiding real content', () => {
    // The one place `overflow: hidden` plus a 1px box is correct, and it is the mechanism
    // every screen-reader-only string in the app depends on.
    const decls = declarationsFor('light', 'eoy-visually-hidden');
    expect(lengthsToPx('light', decls['width'] ?? '')).toBe(1);
    expect(lengthsToPx('light', decls['height'] ?? '')).toBe(1);
    expect(decls['clip-path']).toBe('inset(50%)');
  });

  it('the body line-height leaves room for a 1.5x override', () => {
    const body = elementDeclarations('body');
    // 1.5 is already the AA-recommended base; the point is that it is set at all, since
    // browsers default to ~1.2 and a fixed-height control then has less room than assumed.
    expect(Number(resolve('light', body['line-height'] ?? ''))).toBeGreaterThanOrEqual(1.5);
  });
});

describe('reflow (WCAG 2.2 SC 1.4.10, AA)', () => {
  it('a narrow-width query exists, and it covers the 320px the criterion names', () => {
    const widths = [...CSS_NO_COMMENTS.matchAll(/@media\s*\(max-width:\s*([\d.]+)(rem|px)\)/g)]
      .map((m) => lengthsToPx('light', `${m[1]}${m[2]}`))
      .filter((w): w is number => w !== null);
    expect(widths.length, 'no max-width media query at all').toBeGreaterThan(0);

    /*
     * WCAG 1.4.10 does not ask for a breakpoint AT 320px. It asks that the content work at
     * 320px without two-dimensional scrolling, and a `max-width` query at any width >= 320 is
     * what makes that happen — the styles inside it are in force at 320 too. So the assertion
     * is that the narrowest such query is wide enough to include 320 and narrow enough that it
     * is clearly about small screens.
     *
     * The first version of this test demanded a breakpoint at or below 320 and failed against
     * a correct `max-width: 30rem` (480px) header stack, which is the very rule that makes
     * 320px work. A test that fails on correct code teaches people to ignore it.
     */
    const narrowest = Math.min(...widths);
    expect(narrowest, `the narrowest max-width query is ${narrowest}px, which excludes 320px`).toBeGreaterThanOrEqual(320);
    expect(narrowest, `${narrowest}px is not a small-screen width`).toBeLessThanOrEqual(480);
  });

  it('the app shell never fixes a width, because the shell is the viewport', () => {
    const offenders = readBlocks()
      .filter((b) => /^\s*(width|min-width)\s*:\s*[\d.]+(px|rem)/m.test(b.body))
      .filter((b) => /eoy-app\b|eoy-app__body|eoy-stage\b|eoy-header\b|eoy-header__bar/.test(b.selector))
      .map((b) => b.selector);
    expect(offenders, 'the shell must be sized by the viewport, not by a fixed width').toEqual([]);
  });

  it('the app shell uses a fixed-position full-viewport box', () => {
    const shell = declarationsFor('light', 'eoy-app');
    expect(shell['position']).toBe('fixed');
    expect(shell['inset']).toBe('0');
  });

  it('the search field can shrink, because it is the thing squeezed on a narrow phone', () => {
    const search = declarationsFor('light', 'eoy-search');
    expect(search['min-width']).toBe('0');
    expect(search['flex']).toContain('1 1');
  });

  it('the filter rail scrolls rather than wrapping, so the header cannot resize the map', () => {
    // A wrapping rail changes the header height, which resizes the map, and a map that
    // resizes when you pick a filter loses the place you were looking at.
    const rail = declarationsFor('light', 'eoy-rail__scroll');
    expect(rail['overflow-x']).toBe('auto');
    expect(declarationsFor('light', 'eoy-rail__chips')['flex-wrap']).toBeUndefined();
  });
});

describe('the user-preference overrides the design system promises are actually present', () => {
  it('reduced motion is honoured', () => {
    expect(CSS_NO_COMMENTS).toMatch(/@media \(prefers-reduced-motion: reduce\)/);
  });

  it('forced colors is honoured, with the selected state re-established by an outline', () => {
    // In forced-colors the system repaints everything, so a background change is not a
    // reliable signal. The selected chip, the active view and the selected row each have to
    // say so with something the system will keep.
    expect(CSS_NO_COMMENTS).toMatch(/@media \(forced-colors: active\)/);
    const block = /@media \(forced-colors: active\) \{[\s\S]*?\n\}\n/.exec(CSS_NO_COMMENTS)?.[0] ?? '';
    expect(block, 'forced-colors has no selected-state outline').toContain('outline: 2px solid Highlight');
    for (const selector of ['.eoy-chip:has(:checked)', ".eoy-row[aria-current='true']"]) {
      expect(block).toContain(selector);
    }
  });

  it('enhanced contrast is honoured, and it does not simply reuse the light values in dark', () => {
    // The first version of this block set a black control border and a light chip in BOTH
    // schemes, which measured 1.21:1 and 1.30:1 for a user who wants enhanced contrast in
    // dark mode. So the dark half of the block is asserted to exist, not just the block.
    const nested = /@media \(prefers-contrast: more\) \{[\s\S]*@media \(prefers-color-scheme: dark\)/.test(
      CSS_NO_COMMENTS,
    );
    expect(nested, 'prefers-contrast has no dark-scheme half').toBe(true);
  });

  it('the safe-area inset is applied to the floating bar and the bottom sheet', () => {
    for (const selector of ['eoy-bottom-bar', 'eoy-sheet']) {
      expect(declarationsFor('light', selector)['padding-bottom'], selector).toContain(
        'var(--eoy-safe-bottom)',
      );
    }
  });
});
