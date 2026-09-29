/**
 * LAYOUT RESILIENCE. The WCAG success criteria that are about the box rather than the
 * colour, and that no other suite in this repo can check: target size (2.5.8), text spacing
 * (1.4.12), reflow (1.4.10) and focus not obscured (2.4.11).
 *
 * Underneath them sit four declarations that are not criteria at all and would be fixed by
 * nobody on a desktop: the skip link is off-screen to anyone without a keyboard, a scroller
 * that can rubber-band the page, a popup sized in the viewport height a phone hides, and
 * headings that wrap into a rag. Every one of them is invisible to a screenshot, because the
 * screenshot is taken on the platform where none of them happen.
 *
 * All four were previously comments in `src/index.css` — a promise with nothing behind it.
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

import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve as resolvePath } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CSS_NO_COMMENTS,
  cascadeFor,
  classesIn,
  declarationsFor,
  elementDeclarations,
  lengthsToPx,
  palette,
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
    //
    // The BASELINE rule, not `declarationsFor`: on a short viewport the rail's own scrolling
    // is released so the header can scroll as one strip, and that release is a later rule
    // with the same selector. This is about what the rail does at every other size.
    const rail = baselineDeclarations('eoy-rail__scroll');
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

/** A declared length in pixels, or a failure naming the declaration it could not read. */
function px(value: string, where: string): number {
  const out = lengthsToPx('light', value);
  if (out === null) throw new Error(`${where} is "${value}", which is not a length this suite can read`);
  return out;
}

/**
 * The declarations of the rule whose selector is EXACTLY this class, first match wins.
 *
 * `declarationsFor` merges every rule that matches the class with the last one winning, and
 * `readBlocks` does not record whether a rule it handed back was inside a media query: it
 * flattens an at-rule by leaving the `@media` text on the FIRST rule inside it only, so every
 * later rule in the same query comes back looking like a top-level rule. An override that is
 * true only on a short viewport therefore arrives at `declarationsFor` as though it were the
 * element's ordinary behaviour — which is how the short-viewport strip's release of the rail's
 * `overflow-x` read as the rail's base value, and how the `mask-image: none` that goes with it
 * read as "the rail no longer fades".
 *
 * Correct when the question is "what does this rule say", wrong when the question is "what is
 * this element's baseline". Both users below want the baseline, and in each case the base rule
 * is declared above the query that overrides it.
 */
function baselineDeclarations(className: string): Record<string, string> {
  const block = readBlocks().find((b) => b.selector.trim() === `.${className}`);
  const out: Record<string, string> = {};
  for (const decl of (block?.body ?? '').split(';')) {
    const colon = decl.indexOf(':');
    if (colon < 0) continue;
    const property = decl.slice(0, colon).trim();
    const value = decl.slice(colon + 1).trim();
    if (property !== '' && value !== '') out[property] = value;
  }
  return out;
}

describe('focus not obscured (WCAG 2.2 SC 2.4.11, AA)', () => {
  /**
   * The one part of 2.4.11 this suite can read: the axis the filter rail scrolls on.
   *
   * A browser brings a newly focused element to the very edge of its scrollport, and this
   * rail's edges are not the page edges — they are covered by a decorative fade, so "at the
   * edge of the scrollport" is not "fully visible". The chip is focused through a 1px input
   * that is hidden from the eye, which is the shape that makes this easy to get wrong: the
   * browser has nothing to scroll to but the sliver.
   */
  it('a focused filter chip is scrolled clear of the fade the rail ends in', () => {
    const fade = /calc\(100%\s*-\s*([\d.]+rem)\)/.exec(
      baselineDeclarations('eoy-rail__scroll')['mask-image'] ?? '',
    )?.[1];
    if (fade === undefined) throw new Error('the rail no longer fades its right edge, so this check is stale');
    const fadePx = px(fade, 'the rail fade');

    /*
     * On the INPUT's rule, not the chip's: `scroll-margin` is not inherited, and the input is
     * the element that takes focus and the one the scroll offset is computed from. Declared on
     * `.eoy-chip` it would read as a rule about a box that nothing ever scrolls into view —
     * which is exactly the bug this assertion exists to prevent.
     */
    const input = readBlocks().find((b) => b.selector === '.eoy-chip input');
    const declared = /scroll-margin-inline:\s*([^;]+)/.exec(input?.body ?? '')?.[1];
    if (declared === undefined) {
      throw new Error('the chip input declares no scroll-margin-inline, so a focused chip rests under the fade');
    }
    // Two values are start then end, as in `margin`. One value is both.
    const [start, end] = resolve('light', declared).trim().split(/\s+/);
    const startPx = px(start ?? '', 'the chip scroll-margin start');
    const endPx = px(end ?? start ?? '', 'the chip scroll-margin end');
    // The chip's indicator is a 3px outline at a 2px offset, and the scrollport clips it.
    expect(startPx, 'the focused chip rests against the left scrollport edge').toBeGreaterThanOrEqual(5);
    expect(endPx, 'the focused chip comes to rest inside the rail fade').toBeGreaterThanOrEqual(fadePx);
  });
});

describe('a phone has no Tab key, so the skip link cannot depend on :focus-visible', () => {
  it('the skip link is revealed by plain :focus as well as by :focus-visible', () => {
    /*
     * `src/App.tsx` renders the skip link as a `<button>`, and neither Safari on iOS nor
     * Chrome on Android applies `:focus-visible` to a tapped button. Without a `:focus` rule
     * the one escape hatch out of the header is translated off the top of the viewport for
     * exactly the visitors who have no other way to skip it.
     *
     * The hiding declaration is read off the base rule rather than through `declarationsFor`,
     * which merges every matching rule with the last one winning — so it would have reported
     * `translateY(0)` here and proved the opposite of the truth.
     */
    const base = readBlocks().find((b) => b.selector === '.eoy-skip-link');
    expect(base?.body, 'the skip link is no longer hidden by default').toMatch(/transform:\s*translateY\(\s*-/);

    const reveal = (selector: string): boolean =>
      readBlocks().some(
        (b) => b.selector === selector && /transform:\s*translateY\(\s*0\s*\)/.test(b.body),
      );
    expect(reveal('.eoy-skip-link:focus'), 'a tapped skip link stays off-screen').toBe(true);
    // Kept deliberately: this is the rule the rest of the stylesheet's focus story assumes.
    expect(reveal('.eoy-skip-link:focus-visible')).toBe(true);
  });
});

describe('no scroll container can move the page past its own edge', () => {
  it('every scroller contains its own overscroll', () => {
    /*
     * `body` already sets `overscroll-behavior-y: none`, and it does not help here: on iOS the
     * rubber band is drawn by the scroller that was over-scrolled, not by the page it fails
     * to move. So the declaration belongs on each scroller, and the list is derived from the
     * `overflow` declarations rather than written out — otherwise the next scroll region
     * added to this stylesheet would arrive unguarded.
     *
     * The rail already declares `overscroll-behavior-x: contain`, and that counts: `contain`
     * is the value, whether it arrived through the shorthand or through one axis.
     */
    const scrollers = readBlocks().filter((b) =>
      /(^|[;{\s])overflow(-[xy])?\s*:\s*(auto|scroll)\b/.test(b.body),
    );
    expect(scrollers.length, 'no scroll container at all, so this assertion proves nothing').toBeGreaterThan(0);

    for (const block of scrollers) {
      // Every scroller in this file is a bare single-class rule. If one is not, the class this
      // assertion would read is the wrong box, so it fails loudly rather than passing on a
      // declaration that belongs to something else.
      const classes = classesIn(block.selector);
      expect(classes.length, `${block.selector} names no single class to check`).toBe(1);
      const decls = declarationsFor('light', classes[0] ?? '');
      expect(
        decls['overscroll-behavior'] ?? decls['overscroll-behavior-y'] ?? decls['overscroll-behavior-x'] ?? '(nothing)',
        `${block.selector} scrolls, so an over-scroll at its end must not chain to the page`,
      ).toContain('contain');
    }
  });
});

describe('nothing is sized in `vh`, which is the viewport with the toolbar hidden', () => {
  it('the search panel prefers `dvh`, and keeps `vh` in front of it as the fallback', () => {
    /*
     * The only vertical viewport unit in the file, in the one place that hangs over content:
     * on a handset the phone's URL bar shrinks `vh` but not `dvh`, so the panel could reach
     * under the bar while the bar was showing. Engines that predate `dvh` (Safari before 15.4)
     * discard a declaration they cannot parse, which is what makes the older value first and
     * the newer one second a fallback rather than a duplicate.
     *
     * `vw` is deliberately not flagged: the mobile toolbar changes the viewport HEIGHT, not
     * its width, so the one `vw` in the wide-layout sheet has no equivalent trap.
     */
    const offenders = readBlocks().flatMap((block) => {
      const declared = [...block.body.matchAll(/([\w-]+)\s*:\s*([^;]+)/g)].map(
        (m) => [m[1] ?? '', m[2]?.trim() ?? ''] as const,
      );
      return declared.flatMap(([property, value], index) => {
        if (!/[\d.]+vh\b/.test(value)) return [];
        /*
         * A `vh` value is allowed in exactly one shape: as the fallback for a `dvh` value of
         * the same property, declared immediately after it so an engine that cannot parse
         * `dvh` has already dropped the newer declaration and kept this one. Anything else is a
         * box sized against the viewport with the phone's toolbar hidden.
         */
        const next = declared[index + 1];
        const isFallback = next !== undefined && next[0] === property && /[\d.]+dvh\b/.test(next[1]);
        return isFallback ? [] : [`${block.selector} { ${property}: ${value} }`];
      });
    });
    expect(
      offenders,
      `these declarations size something in \`vh\`, which on a phone is the viewport with the URL\n` +
        `bar hidden. Declare the \`dvh\` value second and keep the \`vh\` value first as the fallback.\n  ${offenders.join('\n  ')}`,
    ).toEqual([]);

    const panel = readBlocks().find((b) => b.selector === '.eoy-search__panel');
    const declared = [...(panel?.body ?? '').matchAll(/max-height:\s*([^;]+);/g)].map((m) =>
      m[1]?.trim(),
    );
    expect(declared, 'the search panel no longer declares a max-height in viewport units').toEqual([
      'min(60vh, 24rem)',
      'min(60dvh, 24rem)',
    ]);
  });
});

describe('wrapped text (readability rather than a criterion)', () => {
  it('every heading in the app balances its lines', () => {
    // A heading is the one place an even rag is visible as a defect: two lines of very
    // different lengths read as a heading and a subtitle rather than one heading.
    const HEADINGS = [
      'eoy-wordmark', // h1, src/App.tsx
      'eoy-list__title', // h2, src/components/LocationList.tsx
      'eoy-sheet__title', // h2, src/components/DetailSheet.tsx
      'eoy-card__title', // h2 and, with --small, h3, src/components/StateCards.tsx
    ] as const;
    for (const selector of HEADINGS) {
      expect(declarationsFor('light', selector)['text-wrap'], `.${selector} does not balance its lines`).toBe(
        'balance',
      );
    }
  });

  it('the shell grid track may shrink below its content, or a phone loses its header', () => {
    // `.eoy-app__body` is a one-column grid, and an implicit `auto` track takes its base size
    // from the largest min-content contribution in it. `.eoy-modes` is a horizontal scroller
    // with two `min-width: 9rem` options whose descriptions wrap, so that contribution is
    // 740px — and `overflow-x: auto` does not reduce it, because that rule is about a flex or
    // grid ITEM and this is a block inside a block. On a 390px phone the track became 740px,
    // the header overflowed, and "Near me" and the other feature's switcher option were laid
    // out past the right edge of the screen. `minmax(0, 1fr)` is the whole fix.
    //
    // The rule of the class is that the scroller scrolls and the track shrinks; a change
    // back to a bare `auto` column reintroduces a 740px header on every phone.
    expect(cascadeFor('eoy-app__body', [])['grid-template-columns']).toBe('minmax(0, 1fr)');
  });

  it('the place name is set to pretty, so a wrapped name has no one-word last line', () => {
    // `pretty`, not `balance`: these are running text, and they are the dataset's own
    // UPPERCASE names, which wrap in the middle of a word's worth of letters rather than at
    // a convenient boundary. Balancing would treat them as headings.
    for (const selector of ['eoy-row__name', 'eoy-search__option-name']) {
      expect(declarationsFor('light', selector)['text-wrap'], `.${selector} does not set text-wrap`).toBe(
        'pretty',
      );
    }
  });
});

/**
 * EVERY `var(--token)` IN THE STYLESHEET NAMES A TOKEN THAT EXISTS.
 *
 * This is not a style preference and it is not caught by anything else in the repository, so
 * it is worth spelling out what goes wrong. A `var()` that names an undefined custom property
 * does not fall back to the next declaration, does not become the initial value, and does not
 * show up as an error: the declaration it appears in is invalid at computed-value time and is
 * dropped, silently, for every element the rule matches. `max-height: calc(100% -
 * var(--eoy-header-height) - var(--eoy-space-6))` did exactly that — `--eoy-space-6` was never
 * defined, so the wide-layout detail sheet had `max-height: none` and no height limit at all.
 * Eat Outside never noticed, because its sheet is 649px tall and never needed the clamp. It
 * became visible the moment Where NYC Walks opened a sheet with 37 survey bars in it: the
 * panel grew past the viewport, and the sheet opened with its own title and its own close
 * button above the top of the screen.
 *
 * The failure is invisible in a screenshot taken on a machine where the declaration happens
 * not to matter, and it is invisible to a colour audit, so it is checked here against the raw
 * stylesheet. Reading the text is enough: a token is defined somewhere in the file or it is
 * not, and there is no cascade subtlety to get wrong.
 */

/**
 * Custom property names set from TypeScript, as inline styles.
 *
 * `'--name': value` or `"--name": value`, which is how a computed custom property has to be
 * written in TSX — the alternative, a cast on a bare object key, is the kind of thing
 * `AGENTS.md` rules out. Walks `src/` recursively so the two halves of the channel cannot
 * drift: a name the stylesheet reads but no component sets is still a failure, because it is
 * the same bug with the tokens on the other side.
 */
function inlineCustomProperties(): string[] {
  const names: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(path);
        continue;
      }
      if (!/\.(ts|tsx|css)$/.test(entry.name)) continue;
      // A quoted `--name` in a TS or TSX file is a custom property: there is no other
      // reading of it. The `as string` in `['--wnyc-swatch' as string]` is why this matches
      // the name and not the whole key.
      for (const match of readFileSync(path, 'utf8').matchAll(/['"`](--[\w-]+)['"`]/g)) {
        names.push(match[1] as string);
      }
    }
  };
  walk(resolvePath(process.cwd(), 'src'));
  return names;
}
describe('every custom property the stylesheet reads is one it defines', () => {
  it('has no `var(--token)` naming a token that is neither defined nor set by a component', () => {
    const defined = new Set([
      ...[...CSS_NO_COMMENTS.matchAll(/(--[\w-]+)\s*:/g)].map((match) => match[1] as string),
      // A component may hand a value to the stylesheet through an inline style, and
      // Where NYC Walks's legend does: four `--wnyc-swatch*` properties are set on the swatch
      // element in `WalkLegend.tsx` and consumed by `.wnyc-legend__swatch` in the stylesheet.
      // That is a legitimate second source, so the audit reads `src/` for them rather than
      // pretending the stylesheet is the only one. A typo in either half still fails.
      ...inlineCustomProperties(),
    ]);
    const read = new Set(
      [...CSS_NO_COMMENTS.matchAll(/var\(\s*(--[\w-]+)/g)].map((match) => match[1] as string),
    );

    const missing = [...read].filter((token) => !defined.has(token)).sort();
    expect(
      missing,
      `src/index.css reads custom properties it never defines: ${missing.join(', ')}. ` +
        'A var() naming an undefined property invalidates the whole declaration at ' +
        'computed-value time, so the rule silently does nothing.',
    ).toEqual([]);
  });

  it('reads at least the properties the layout actually depends on', () => {
    // A guard on the guard: an empty or trivially small read set would make the assertion
    // above pass for the wrong reason, which is the failure mode this whole file is about.
    const read = new Set(
      [...CSS_NO_COMMENTS.matchAll(/var\(\s*(--[\w-]+)/g)].map((match) => match[1] as string),
    );
    expect(read.size).toBeGreaterThan(30);
    for (const token of ['--eoy-header-height', '--eoy-space-4', '--eoy-tap']) {
      expect(read.has(token), `nothing reads ${token}, so the token audit may be hollow`).toBe(true);
    }
  });
});

/**
 * The whole body of an at-rule block, with its braces matched.
 *
 * `CSS_NO_COMMENTS.slice(indexOf(query), indexOf('}', ...))` — the obvious way to read one —
 * stops at the FIRST closing brace after the query, which for an at-rule that opens with
 * `:root { … }` is the end of that nested block and not the end of the query. Every rule this
 * suite wants to read about a query is after it, so that slice reads a `:root` and nothing
 * else, and the assertions below pass on an empty block.
 */
function atRuleBlock(query: string): string {
  const start = CSS_NO_COMMENTS.indexOf(query);
  if (start < 0) return '';
  let depth = 0;
  for (let i = CSS_NO_COMMENTS.indexOf('{', start); i < CSS_NO_COMMENTS.length; i += 1) {
    const char = CSS_NO_COMMENTS[i];
    if (char === '{') depth += 1;
    else if (char === '}' && (depth -= 1) === 0) return CSS_NO_COMMENTS.slice(start, i + 1);
  }
  return '';
}

/**
 * Every `:root` rule in the stylesheet, with the media queries it sits inside.
 *
 * `readBlocks()` CANNOT be used for this. It flattens a nested block by leaving the at-rule
 * text on the FIRST rule inside it, so `:root` directly after `@media (…) {` comes back with
 * the at-rule on its selector (and is then dropped, because the selector starts with `@`) while
 * every later rule in the same query comes back looking top-level. `palette()` reads the FIRST
 * `:root` block only for the same reason, which is precisely the hole this audit is written to
 * close: a query that RAISED a token would be invisible to every reader in
 * `tests/helpers/stylesheet.ts` while being true in a browser.
 *
 * So this walks the braces itself: into `@media`, over `@keyframes`, and one level at a time.
 */
function rootBlocks(): { context: string; body: string }[] {
  const out: { context: string; body: string }[] = [];
  const conditions: string[] = [];
  let i = 0;
  while (i < CSS_NO_COMMENTS.length) {
    const open = CSS_NO_COMMENTS.indexOf('{', i);
    if (open < 0) break;
    const head = CSS_NO_COMMENTS.slice(i, open).trim();
    let depth = 0;
    let close = open;
    for (; close < CSS_NO_COMMENTS.length; close += 1) {
      const char = CSS_NO_COMMENTS[close];
      if (char === '{') depth += 1;
      else if (char === '}' && (depth -= 1) === 0) break;
    }
    if (head.startsWith('@media')) {
      conditions.push(head);
      i = open + 1; // descend: the rules inside a query are the ones being audited
      continue;
    }
    if (head.startsWith('@')) {
      i = close + 1; // @keyframes and friends: their percentages are not rules
      continue;
    }
    if (head.split(',').some((compound) => compound.trim() === ':root')) {
      out.push({ context: conditions.join(' '), body: CSS_NO_COMMENTS.slice(open + 1, close) });
    }
    conditions.pop();
    i = close + 1;
  }
  return out;
}

/**
 * THE HEADER, ON A SCREEN THAT IS NOT TALL.
 *
 * The header is three stacked rows — the bar, the feature switcher, the filter rail — and
 * every one of them has a `min-height`. On a 390 × 844 phone that is 28.7% of the screen,
 * which is fine. On an 844 × 390 phone in landscape it was 50.8%: the map got 192px and the
 * detail sheet got 194px, and both were measured, not estimated.
 *
 * The fix is a `max-height` query that turns the three rows into ONE horizontally-scrolling
 * strip. That reuses an idiom this stylesheet already uses twice (`.eoy-modes` and
 * `.eoy-rail__scroll` both scroll rather than wrap, precisely so the header cannot change
 * height), and it is the only arrangement in which a 390px-tall screen has room for a map.
 */
describe('a phone in landscape is a short viewport, not a narrow one', () => {
  const SHORT = '@media (max-height: 40rem)';

  it('has a short-viewport query, because no width query can describe a landscape phone', () => {
    // 844 × 390 is WIDE. Both existing queries are `max-width: 30rem` (a narrow phone) and
    // `min-width: 45rem` (a desktop). Neither is true at 844 × 390, so a header that is
    // sized only by width queries is sized for the wrong axis entirely.
    expect(CSS_NO_COMMENTS).toContain(SHORT);
  });

  it('collapses the header to one horizontally-scrolling row', () => {
    const block = atRuleBlock(SHORT);
    expect(block, `${SHORT} is not in the stylesheet`).not.toBe('');
    // The strip, not a wrap. A wrapped header changes height when a filter chip wraps, which
    // resizes the map — the exact failure the two existing scrollers were written to avoid.
    expect(block).toMatch(/overflow-x:\s*auto/);
    expect(block).not.toMatch(/flex-wrap:\s*wrap/);
  });

  it('stops the rail and the switcher from becoming nested scrollers inside the strip', () => {
    // Two horizontal scrollers stacked is a gesture trap: a touch that starts inside the
    // inner one is consumed by it, and the visitor cannot reach the outer strip's content by
    // swiping on the part of the screen they are looking at. The inner `overflow-x` has to
    // be released in the same block that introduces the outer one.
    const block = atRuleBlock(SHORT);
    expect(block).toMatch(/overflow-x:\s*visible/);
  });

  it('reports a header height that is an upper bound at every viewport', () => {
    // `--eoy-header-height` is read by the detail sheet for its `max-height`. A token that
    // UNDER-states the header slides the sheet up underneath it, which is how the sheet came
    // to open over the filter rail on a 320px phone. An over-estimate costs the sheet a few
    // px of height and the sheet scrolls, so the invariant is: the value declared in the
    // FIRST `:root` block — the one every audit reads — is the WORST case, and the media
    // queries below it may only ever REDUCE it.
    //
    // The real render, against the token, at three viewports:
    //   390 × 844  real 223px   token 232px   (+9)
    //   320 × 568  real 112px   token 120px   (+8)
    //   844 × 390  real  68px   token 120px   (+52)
    const values = palette('light');
    const header = values['--eoy-header-height'];
    expect(header, '--eoy-header-height is not declared in the first :root block').toBeDefined();

    // All three terms, by name. A hand-written length would satisfy `lengthsToPx` and fail
    // this, which is the point: the failure this guards is the one that happened, a token
    // that quietly stopped being the sum of the rows it claims to describe.
    for (const term of ['--eoy-bar-height', '--eoy-bar-wrap', '--eoy-extra-rows']) {
      expect(header, `--eoy-header-height must be the sum of its rows, and omits ${term}`)
        .toContain(`var(${term})`);
    }

    // And the arithmetic actually adds up, which catches a term that is summed twice or a
    // `calc()` with a stray operator. `lengthsToPx` resolves the var() chain and sums.
    const px = (name: string): number => {
      const found = lengthsToPx('light', values[name] ?? '');
      expect(found, `${name} is not a length the helper can measure`).not.toBeNull();
      return found as number;
    };
    expect(px('--eoy-header-height')).toBeCloseTo(
      px('--eoy-bar-height') + px('--eoy-bar-wrap') + px('--eoy-extra-rows'),
      0,
    );
  });

  it('has no media query that raises a token above its first-:root value', () => {
    // The mirror of the test above, and the one that keeps the audits honest.
    // `tests/helpers/stylesheet.ts` reads the FIRST `:root` block only (see `rootBlocks`
    // above), so a query that RAISED a token would be invisible to every audit while being
    // true in the browser — a second `:root` that contradicts the first is precisely the
    // failure mode that helper was written to prevent. The walk-stylesheet comment above
    // `tests/walk-stylesheet.test.ts` records finding exactly that.
    //
    // So: every `:root`-level override in the stylesheet must be a REDUCTION. The two that
    // exist after this task are `--eoy-bar-wrap` (45rem query, 3.25rem → 0rem) and
    // `--eoy-extra-rows` (40rem height query, 7rem → 0rem); the dark and enhanced-contrast
    // blocks recolour tokens rather than resize them and are skipped by the length pattern.
    const values = palette('light');
    const raised: string[] = [];

    for (const block of rootBlocks()) {
      if (block.context === '') continue; // the first `:root` is the value everything is read against
      for (const match of block.body.matchAll(/(--[\w-]+)\s*:\s*([\d.]+)rem\s*;/g)) {
        const name = match[1] as string;
        const override = Number.parseFloat(match[2] as string);
        const base = values[name];
        if (base === undefined) continue;
        const basePx = lengthsToPx('light', base);
        if (basePx === null) continue; // a calc(), or a colour: not a length override
        const overridePx = override * 16;
        if (overridePx > basePx) {
          raised.push(`${name}: the first :root says ${base} but a query raises it to ${match[2]}rem`);
        }
      }
    }

    expect(
      raised,
      `these media queries raise a token above the first-:root value, which is the only value ` +
        `any audit reads:\n  ${raised.join('\n  ')}`,
    ).toEqual([]);
  });

  it('keeps the bottom sheet clear of the header, because 82% of a short screen is under it', () => {
    // Measured at 320 × 568: the sheet's top edge was y 102 and the header's bottom edge was
    // y 242. The sheet covered the feature switcher and the whole filter rail — the two
    // controls that change what the sheet is about. `min(82%, 36rem)` is a percentage of the
    // viewport, and the viewport is not the header's friend.
    //
    // The BASE rule, matched exactly rather than through `declarationsFor`, which walks every
    // block that mentions the class and would return the `@media (min-width: 45rem)` override
    // further down the file — a rule that already reads `--eoy-header-height`, so the
    // assertion would pass before anything changed. The narrow layout is the one with the bug
    // and the base selector is the only place it lives.
    const base = readBlocks().find((b) => b.selector.trim() === '.eoy-sheet');
    expect(base, 'there is no bare `.eoy-sheet` rule outside a media query').toBeDefined();

    const heights = (base?.body.match(/max-height\s*:/g) ?? []).length;
    expect(heights, 'the clamp is missing or has lost its percentage fallback').toBe(2);
    expect(base?.body).toContain('min(82%, 36rem)');
    expect(base?.body).toContain('var(--eoy-header-height)');
  });

  it('leaves the wide layout’s own clamp alone, because its geometry is different', () => {
    // The side panel sits BESIDE the map with the bottom bar under it, not over it, so it
    // subtracts `--eoy-space-5` rather than `--eoy-space-3`. Two different numbers for two
    // different geometries is correct; a shared one would be wrong in one of them.
    const wide = /@media \(min-width: 45rem\)\s*\{[\s\S]*?\.eoy-sheet\s*\{([\s\S]*?)\}/.exec(
      CSS_NO_COMMENTS,
    );
    expect(wide?.[1], 'the wide-layout sheet clamp is missing').toBeDefined();
    expect(wide?.[1]).toContain('var(--eoy-header-height)');
    expect(wide?.[1]).toContain('var(--eoy-space-5)');
  });
});
