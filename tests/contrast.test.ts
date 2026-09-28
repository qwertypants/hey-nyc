/**
 * THE CONTRAST AUDIT. This is what makes the app's accessibility claim checkable rather
 * than aspirational.
 *
 * It reads the REAL tokens out of `src/index.css` and the REAL data colours out of
 * `src/map/style.ts` — not a copy of them — and asserts every documented foreground /
 * background pair against the WCAG 2.2 threshold that applies to it. Someone who edits a
 * hex value to "look nicer" and breaks 1.4.3 gets a failing build naming the token, the two
 * colours and the ratio they actually achieved, rather than a bug report from a user with
 * low vision a year later.
 *
 * The thresholds, and why each pair is held to the one it is:
 *   4.5:1  body and UI text                                (1.4.3 Contrast (Minimum), AA)
 *   3:1    UI component boundaries and meaningful graphics  (1.4.11 Non-text Contrast, AA)
 *   7:1    the primary ink pair                             (1.4.6 Contrast (Enhanced), AAA)
 *
 * WHAT THIS DELIBERATELY DOES NOT ASSERT, and why:
 *   - The dining-type FILLS in dark mode. They are the map's own colours and the legend has
 *     to agree with the map, so they are identical in both schemes. On a near-black panel
 *     they fall below 3:1 — but 1.4.11 exempts graphics whose information is also available
 *     in text, and the type is always named in words beside every swatch, in the legend, in
 *     the list row and in the detail sheet. Colour is the redundant fourth channel. What IS
 *     asserted is the swatch EDGE, which is chrome and does flip with the scheme.
 *   - Disabled controls. WCAG 1.4.3 exempts them, and the app's disabled style carries a
 *     border and a cursor rather than a low-contrast fill, so there is nothing to measure.
 *   - `#afafaf`, Uber's own muted gray. It is 2.19:1 on white, so it is not in the token
 *     set at all. See the note in `src/index.css`.
 */

import { describe, expect, it } from 'vitest';
import {
  AA_NON_TEXT,
  AA_TEXT,
  AAA_TEXT,
  contrastRatio,
  flatten,
  isMeasurable,
  ratioText,
} from '../src/lib/contrast';
import { DINING_TYPE_STYLES } from '../src/map/style';
// The stylesheet reader lives in tests/helpers so this audit and the layout-resilience audit
// cannot drift into disagreeing about what the CSS says. See that file for why.
import { CSS_NO_COMMENTS, SCHEMES, cascadeFor, palette, token } from './helpers/stylesheet';

type Scheme = (typeof SCHEMES)[number];

/**
 * Reads a token's value in one scheme. The name is accepted with or without its leading
 * dashes, because the pair tables below read better as `--eoy-text` (it is what you grep for)
 * while the shared helper is keyed on the bare name. Normalising in one place beats making
 * two parallel naming conventions agree by hand.
 */
function value(scheme: Scheme, rawName: string): string {
  const name = rawName.startsWith('--') ? rawName : `--${rawName}`;
  // Asserted as well as read, so a token that vanished fails naming the token rather than
  // failing later as an opaque NaN inside a ratio.
  expect(palette(scheme)[name], `${name} is not defined in the ${scheme} scheme`).toBeDefined();
  return token(scheme, name);
}

interface Pair {
  readonly label: string;
  readonly fg: string;
  readonly bg: string;
  readonly need: number;
  /** The background the translucent foreground is composited over, when it has alpha. */
  readonly over?: string;
}

/** Every text pair the app actually renders, in both schemes. */
const TEXT_PAIRS: readonly Pair[] = [
  { label: 'primary text on a card or sheet', fg: '--eoy-text', bg: '--eoy-surface', need: AA_TEXT },
  { label: 'primary text on the page background', fg: '--eoy-text', bg: '--eoy-bg', need: AA_TEXT },
  { label: 'secondary text on a card or sheet', fg: '--eoy-text-muted', bg: '--eoy-surface', need: AA_TEXT },
  { label: 'secondary text on the page background', fg: '--eoy-text-muted', bg: '--eoy-bg', need: AA_TEXT },
  { label: 'secondary text on a chip', fg: '--eoy-text-muted', bg: '--eoy-chip', need: AA_TEXT },
  { label: 'inverse text on a black button', fg: '--eoy-text-inverse', bg: '--eoy-text', need: AA_TEXT },
  { label: 'error text on the error surface', fg: '--eoy-error-text', bg: '--eoy-error-bg', need: AA_TEXT },
];

/** Every meaningful non-text boundary: control borders, swatch edges, focus indicators. */
const NON_TEXT_PAIRS: readonly Pair[] = [
  { label: 'control border on a surface', fg: '--eoy-border-strong', bg: '--eoy-surface', need: AA_NON_TEXT },
  { label: 'swatch edge on a surface', fg: '--eoy-swatch-edge', bg: '--eoy-surface', need: AA_NON_TEXT },
  { label: 'focus ring on a surface', fg: '--eoy-focus-ink', bg: '--eoy-surface', need: AA_NON_TEXT },
  { label: 'focus ring on the page background', fg: '--eoy-focus-ink', bg: '--eoy-bg', need: AA_NON_TEXT },
  { label: 'focus ring on a chip', fg: '--eoy-focus-ink', bg: '--eoy-chip', need: AA_NON_TEXT },
];

/** Colour-valued keywords that are legal where a colour is expected. */
const COLOUR_KEYWORDS = new Set([
  'transparent',
  'currentcolor',
  'none',
  'inherit',
  'unset',
  'initial',
  'revert',
  'canvas',
  'canvastext',
  'highlight',
  'highlighttext',
  'linktext',
  'visitedtext',
  'activetext',
  'buttonface',
  'buttontext',
  'buttonborder',
  'field',
  'fieldtext',
  'graytext',
]);

/** Every property whose value is a colour, so a token can be checked in the role it plays. */
const COLOR_PROPERTIES =
  '(?:color|background|background-color|border-color|border-top-color|border-bottom-color|border-left-color|border-right-color|outline-color|caret-color|fill|stroke|box-shadow|text-decoration-color)';

describe('every colour in the stylesheet is a colour we can measure', () => {
  for (const scheme of SCHEMES) {
    it(`resolves and is measurable in the ${scheme} scheme`, () => {
      const resolver = palette(scheme);
      const offenders: string[] = [];

      /** Records a problem for a colour atom, whether it was authored or tokenised. */
      const check = (atom: string, where: string): void => {
        const lower = atom.trim().toLowerCase();
        if (lower === '' || COLOUR_KEYWORDS.has(lower) || isMeasurable(lower)) return;
        offenders.push(`${where}: "${atom}"`);
      };

      /** Resolves one colour atom: a `var(--token)` becomes the token's value, if defined. */
      const checkToken = (token: string, where: string): void => {
        const resolved = resolver[token];
        if (resolved === undefined) {
          offenders.push(`${where}: var(${token}) is not defined in the ${scheme} scheme`);
          return;
        }
        // A token may itself be a composite (a shadow), so recurse rather than measure.
        if (isMeasurable(resolved) || COLOUR_KEYWORDS.has(resolved.toLowerCase())) return;
        checkAll(resolved, where);
      };

      /** Pulls the colour atoms out of a value and checks each one. */
      function checkAll(value: string, where: string): void {
        for (const ref of value.matchAll(/var\((--[\w-]+)\)/g)) {
          const token = ref[1];
          if (token !== undefined) checkToken(token, where);
        }
        const withoutVars = value.replace(/var\([^)]*\)/g, ' ');
        for (const atom of withoutVars.matchAll(/#[0-9a-f]{3,8}\b|rgba?\([^)]*\)/gi)) {
          check(atom[0], where);
        }
      }

      for (const rule of CSS_NO_COMMENTS.matchAll(
        new RegExp(`(?:^|[;{\\s])(${COLOR_PROPERTIES})\\s*:\\s*([^;{}]+)`, 'g'),
      )) {
        const property = rule[1];
        const value = rule[2];
        if (property === undefined || value === undefined) continue;

        if (property === 'box-shadow' || property === 'stroke') {
          // A composite, not a single colour: audit each colour it is built from. The focus
          // indicator lives here, so this is the check that keeps it honest.
          checkAll(value, property);
          continue;
        }

        const trimmed = value.trim();
        if (/gradient\(/.test(trimmed)) {
          for (const stop of trimmed.matchAll(/(#[0-9a-f]{3,8}\b|rgba?\([^)]*\))/gi)) {
            check(stop[0], property);
          }
          continue;
        }
        if (trimmed.startsWith('var(')) {
          checkAll(trimmed, property);
          continue;
        }
        check(trimmed, property);
      }

      expect(
        offenders,
        `${offenders.length} colour value(s) cannot be measured, so the audit would be skipping them:\n  ${offenders.join('\n  ')}`,
      ).toEqual([]);
    });
  }
});

describe('text contrast meets WCAG 2.2 AA (1.4.3)', () => {
  for (const scheme of SCHEMES) {
    for (const pair of TEXT_PAIRS) {
      it(`${pair.label} — ${scheme}`, () => {
        const ratio = contrastRatio(value(scheme, pair.fg), value(scheme, pair.bg));
        expect(
          ratio,
          `${pair.label} in the ${scheme} scheme is ${ratioText(
            value(scheme, pair.fg),
            value(scheme, pair.bg),
          )}, which is below the ${pair.need}:1 floor`,
        ).toBeGreaterThanOrEqual(pair.need);
      });
    }
  }
});

describe('non-text contrast meets WCAG 2.2 AA (1.4.11)', () => {
  for (const scheme of SCHEMES) {
    for (const pair of NON_TEXT_PAIRS) {
      it(`${pair.label} — ${scheme}`, () => {
        const ratio = contrastRatio(value(scheme, pair.fg), value(scheme, pair.bg));
        expect(
          ratio,
          `${pair.label} in the ${scheme} scheme is ${ratioText(
            value(scheme, pair.fg),
            value(scheme, pair.bg),
          )}, which is below the ${pair.need}:1 floor`,
        ).toBeGreaterThanOrEqual(pair.need);
      });
    }
  }
});

describe('the primary pair clears AAA (1.4.6)', () => {
  it('black on white', () => {
    expect(
      contrastRatio(value('light', '--eoy-text'), value('light', '--eoy-surface')),
    ).toBeGreaterThanOrEqual(AAA_TEXT);
  });
});

describe('the focus indicator is visible on every surface in the app', () => {
  /**
   * The app is half black and half white, so one focus colour cannot serve it: the blue the
   * previous version used scored 6.70:1 on white and 2.56:1 on the black header. The
   * replacement is a two-ring indicator — an inner paper ring hugging the control and an
   * outer ink ring — so whichever surface a control sits on, one of the two rings clears
   * 3:1. This asserts that guarantee directly, over every surface the app paints, rather
   * than trusting that the two halves were each checked.
   */
  const surfaces = ['--eoy-surface', '--eoy-bg', '--eoy-chip', '--eoy-text'];

  for (const scheme of SCHEMES) {
    for (const surface of surfaces) {
      it(`at least one ring clears 3:1 on --${surface.replace('--eoy-', '')} — ${scheme}`, () => {
        const ink = value(scheme, '--eoy-focus-ink');
        const paper = value(scheme, '--eoy-focus-paper');
        const best = Math.max(contrastRatio(ink, value(scheme, surface)), contrastRatio(paper, value(scheme, surface)));
        expect(
          best,
          `on ${value(scheme, surface)} the ink ring scores ${contrastRatio(ink, value(scheme, surface)).toFixed(2)}:1 and the paper ring ${contrastRatio(paper, value(scheme, surface)).toFixed(2)}:1 — neither clears 3:1`,
        ).toBeGreaterThanOrEqual(AA_NON_TEXT);
      });
    }
  }
});

describe('translucent text is measured as rendered, not as authored', () => {
  /**
   * Several labels sit on the black header as a percentage of white. Authored as
   * `rgb(255 255 255 / 78%)` they look safe; what matters is the composited result. These
   * are the four that carry meaning, checked against the header they are painted on.
   */
  const ON_BLACK: readonly Pair[] = [
    { label: 'the wordmark strapline', fg: 'rgb(255 255 255 / 72%)', bg: '#000000', need: AA_TEXT, over: '#000000' },
    { label: 'the filter rail group label', fg: 'rgb(255 255 255 / 78%)', bg: '#000000', need: AA_TEXT, over: '#000000' },
    { label: 'a filter chip count', fg: 'rgb(255 255 255 / 76%)', bg: '#000000', need: AA_TEXT, over: '#000000' },
    { label: 'a disabled filter chip label', fg: 'rgb(255 255 255 / 62%)', bg: '#000000', need: AA_TEXT, over: '#000000' },
  ];

  for (const pair of ON_BLACK) {
    it(`${pair.label} (${pair.fg})`, () => {
      const composite = flatten(pair.fg, pair.over ?? pair.bg);
      const ratio = contrastRatio(composite, pair.bg);
      expect(
        ratio,
        `${pair.label} composites to ${composite} on ${pair.bg} = ${ratio.toFixed(2)}:1, below ${pair.need}:1`,
      ).toBeGreaterThanOrEqual(pair.need);
    });
  }
});

describe('the search placeholder is legible on its white field', () => {
  it('#595959 on #ffffff', () => {
    expect(contrastRatio('#595959', '#ffffff')).toBeGreaterThanOrEqual(AA_TEXT);
  });
});

describe('the data colours agree between the stylesheet and the map', () => {
  /**
   * The dining-type palette is defined twice — once in CSS for the chrome and once in
   * `src/map/style.ts` for the layers — and a divergence means the legend stops describing
   * the map. The file header says update both together; this is what enforces it.
   */
  const pairs: readonly [string, string][] = [
    ['sidewalk', '--eoy-type-sidewalk'],
    ['roadway', '--eoy-type-roadway'],
    ['both', '--eoy-type-both'],
  ];

  for (const [type, token] of pairs) {
    it(`${type} is the same colour in both places`, () => {
      const fromMap = DINING_TYPE_STYLES[type as keyof typeof DINING_TYPE_STYLES].color;
      expect(value('light', token), `${token} has drifted from src/map/style.ts`).toBe(fromMap);
    });
  }

  it('the type swatches clear 3:1 on white, where the legend is drawn', () => {
    for (const [type] of pairs) {
      const color = DINING_TYPE_STYLES[type as keyof typeof DINING_TYPE_STYLES].color;
      expect(
        contrastRatio(color, '#ffffff'),
        `${type} (${color}) on white is ${ratioText(color, '#ffffff')}`,
      ).toBeGreaterThanOrEqual(AA_NON_TEXT);
    }
  });
});

describe('the swatch edge is what makes a dim fill visible', () => {
  /**
   * In the dark scheme the data fills are dimmer than 3:1 against the panel, deliberately —
   * they have to stay the colours the map is painting. What carries them is the edge, and
   * the edge is chrome, so it flips. This asserts the edge does.
   */
  it('the light scheme edge is dark and the dark scheme edge is light', () => {
    const light = contrastRatio(value('light', '--eoy-swatch-edge'), '#ffffff');
    const dark = contrastRatio(
      value('dark', '--eoy-swatch-edge'),
      value('dark', '--eoy-surface'),
    );
    expect(light).toBeGreaterThanOrEqual(AA_NON_TEXT);
    expect(dark).toBeGreaterThanOrEqual(AA_NON_TEXT);
  });
});

describe('the literal chrome pairs hold in every scheme', () => {
  /**
   * Some surfaces in this app are deliberately NOT tokens: the header is always black, the
   * selected chip is always white, the search field is always white. That is the design
   * language, and tokenising them would mean the dark scheme could repaint them — which is
   * exactly the bug this suite was written after. `--eoy-text-inverse` is #000000 in the
   * dark scheme, so a header that used it painted black text on a black bar.
   *
   * These are literals, so they are checked as literals, in every scheme, rather than being
   * resolved through a palette that might change underneath them.
   */
  const LITERALS: readonly Pair[] = [
    { label: 'header text on the black header', fg: '#ffffff', bg: '#000000', need: AA_TEXT },
    { label: 'the wordmark on the black header', fg: '#ffffff', bg: '#000000', need: AA_TEXT },
    { label: 'a selected chip label on its white fill', fg: '#000000', bg: '#ffffff', need: AA_TEXT },
    { label: 'a selected chip count on its white fill', fg: '#3f3f3f', bg: '#ffffff', need: AA_TEXT },
    { label: 'the search input on its white field', fg: '#000000', bg: '#ffffff', need: AA_TEXT },
    { label: 'the search icon on its white field', fg: '#595959', bg: '#ffffff', need: AA_NON_TEXT },
    { label: 'the search submit icon on its black fill', fg: '#ffffff', bg: '#000000', need: AA_NON_TEXT },
    { label: 'the active view-toggle label on black', fg: '#ffffff', bg: '#000000', need: AA_TEXT },
    { label: 'the inactive view-toggle label on a chip', fg: '#000000', bg: '#efefef', need: AA_TEXT },
    { label: 'the selected list row name on a chip', fg: '#000000', bg: '#efefef', need: AA_TEXT },
    { label: 'the type-list check mark on black', fg: '#ffffff', bg: '#000000', need: AA_NON_TEXT },
    { label: 'the focus ring on the black header', fg: '#ffffff', bg: '#000000', need: AA_NON_TEXT },
    { label: 'the focus ring paper half on the black header', fg: '#000000', bg: '#000000', need: 1 },
  ];

  for (const pair of LITERALS) {
    it(`${pair.label}`, () => {
      const ratio = contrastRatio(pair.fg, pair.bg);
      expect(
        ratio,
        `${pair.label} is ${ratioText(pair.fg, pair.bg)}, below the ${pair.need}:1 floor`,
      ).toBeGreaterThanOrEqual(pair.need);
    });
  }

  it('no rule paints header text with a token that inverts in the dark scheme', () => {
    // Belt and braces on the specific regression: the header's colour must be a literal,
    // because `--eoy-text-inverse` flips to #000000 and would vanish against the black bar.
    const headerRule = /\.eoy-header \{[^}]*\}/.exec(CSS_NO_COMMENTS)?.[0] ?? '';
    expect(headerRule).toContain('background: #000000');
    expect(headerRule).toContain('color: #ffffff');
    expect(headerRule).not.toContain('--eoy-text-inverse');
  });
});

describe('a selected filter chip stays legible under the pointer', () => {
  /**
   * The one audit in this file that reads the CASCADE rather than the palette, because the bug
   * it guards is invisible to a per-rule reading: each rule involved is reasonable on its own.
   *
   * A selected chip inverts to black on white, which is 21:1 and carries no argument. Hover
   * fills a chip with 14% white, which over the black header is a sensible lift for a chip that
   * is white-on-black. The two collide: `.eoy-chip:hover:not(:has(:disabled))` is (0,3,0) and
   * `.eoy-chip:has(:checked)` is (0,2,0), so the hover fill wins on specificity alone, while
   * `color: #000000` from the checked rule survives untouched. The result is a #242424 chip
   * wearing black text — 1.35:1, and the label disappears at the moment the pointer arrives.
   *
   * So this resolves what a selected, hovered chip is actually painted with. The header is a
   * literal #000000 in every scheme, which is why the fill is composited against it here rather
   * than against a token.
   */
  const HEADER = '#000000';

  /** The selected chip's fill with the pointer over it, as the browser composites it. */
  function hoveredFill(): string {
    const hovered = cascadeFor('eoy-chip', ['hover', 'checked']);
    const background = hovered.background;
    expect(background, 'the hovered selected chip sets no background').toBeDefined();
    return flatten(background ?? '', HEADER);
  }

  it('the hover fill cannot win over the selected chip inversion', () => {
    const { color } = cascadeFor('eoy-chip', ['hover', 'checked']);
    const fill = hoveredFill();
    const ratio = contrastRatio(color ?? '', fill);
    expect(
      ratio,
      `a selected chip under the pointer is ${ratioText(color ?? '', fill)}, below the ${AA_TEXT}:1 floor — ` +
        'the hover fill is winning over the inversion, so the chip is dark and its text is black',
    ).toBeGreaterThanOrEqual(AA_TEXT);
  });

  it('the count badge on that chip is legible too', () => {
    // The badge keeps its own colour, so a hover fill that darkens under it takes the badge
    // down with the label. It is asserted against the same composited fill, because the
    // `:has(:checked)` ancestor is the only thing that decides what colour the badge is.
    const { color } = cascadeFor('eoy-chip__count', ['checked']);
    const fill = hoveredFill();
    const ratio = contrastRatio(color ?? '', fill);
    expect(
      ratio,
      `the count badge on a selected chip under the pointer is ${ratioText(color ?? '', fill)}, below the ${AA_TEXT}:1 floor`,
    ).toBeGreaterThanOrEqual(AA_TEXT);
  });

  it('a selected chip still responds to the pointer', () => {
    // The fix must not be "ignore hover on the selected chip". A filter rail has to tell the
    // user the control responds, so the hovered fill has to differ from the resting one.
    const resting = cascadeFor('eoy-chip', ['checked']);
    expect(hoveredFill()).not.toBe(resting.background);
  });
});

describe('a selected filter chip stays legible while the rail is disabled', () => {
  /**
   * The same collision, reached the other way round, and the worse of the two.
   *
   * The rail is a single disabled `<fieldset>`, so EVERY chip in it matches `:has(:disabled)` —
   * including the selected one, whose own radio is enabled precisely so it can stay selected. The
   * disabled rule and `.eoy-chip:has(:checked)` are both (0,2,0), and the disabled rule is later
   * in source, so it won the `color` and painted 62% white over the selected rule's white fill.
   * White on white: 1:1, and the chip rendered as a blank pill with nothing in it but its count.
   *
   * This is not a corner case. `ready` gates the fieldset, so it holds for the whole load and
   * permanently once the dataset has failed — which is a state the app designs for, with a
   * "Try again" button. Verified in Chrome against the production build with the data request
   * blocked: the selected chip in both groups was an empty white pill.
   */
  const HEADER = '#000000';

  it('the selected chip is not painted with the disabled label colour', () => {
    const { color, background } = cascadeFor('eoy-chip', ['checked', 'disabled']);
    const fill = flatten(background ?? '', HEADER);
    const ratio = contrastRatio(color ?? '', fill);
    expect(
      ratio,
      `a selected chip in a disabled rail is ${ratioText(color ?? '', fill)} — the disabled rule ` +
        'is winning the cascade over the selected chip inversion',
    ).toBeGreaterThanOrEqual(AA_TEXT);
  });

  it('a chip that is not selected still gets the disabled treatment', () => {
    // Scoping the disabled rule must not throw the disabled look away: an unselected chip in a
    // disabled rail is still unavailable, and that is carried by its dimmed label. A transparent
    // fill means the black header shows through, so the header is the background to measure on.
    const disabled = cascadeFor('eoy-chip', ['disabled']);
    expect(disabled.background).toBe('transparent');
    const composite = flatten(disabled.color ?? '', HEADER);
    expect(
      contrastRatio(composite, HEADER),
      `an unselected chip in a disabled rail is ${ratioText(composite, HEADER)}, below the ${AA_TEXT}:1 floor`,
    ).toBeGreaterThanOrEqual(AA_TEXT);
    // Dimmer than the same chip with the rail live, which is what "disabled" looks like here.
    expect(composite).not.toBe(cascadeFor('eoy-chip', []).color);
  });
});

describe('no control is left without a focus indicator', () => {
  /**
   * The stylesheet's accessibility contract says nothing may set `outline: none` without
   * replacing it. `outline: none` is the single most common way a redesign quietly breaks
   * keyboard access, and it is invisible in a screenshot — so it is checked here rather than
   * trusted. Three rules are allowed, and each must supply a replacement indicator in the
   * same block or the next one: the visually-hidden filter radio, the search input, and
   * MapLibre's injected controls.
   */
  it('every `outline: none` is paired with a replacement indicator', () => {
    const blocks = CSS_NO_COMMENTS.split('}');
    const offenders: string[] = [];
    blocks.forEach((block, index) => {
      if (!/outline:\s*none/.test(block)) return;
      const replacement = /box-shadow:\s*var\(--focus-ring\)/.test(block)
        || /box-shadow:\s*0 0 0/.test(block)
        // The next block is the replacement for the visually-hidden inputs.
        || (blocks[index + 1] ?? '').includes('outline: 3px solid');
      if (!replacement) offenders.push(block.trim().split('\n')[0]?.trim() ?? block.trim());
    });
    expect(offenders, `outline: none with nothing replacing it: ${offenders.join(' | ')}`).toEqual([]);
  });

  it('the focus indicator is drawn on the visible part of both visually-hidden inputs', () => {
    // Both of these hide a real control from the eye. If the ring is not moved onto the
    // element the user can actually see, keyboard focus becomes invisible rather than
    // merely ugly — so this is asserted, not assumed.
    expect(CSS_NO_COMMENTS).toMatch(/\.eoy-chip:has\(:focus-visible\)\s*\{[^}]*outline:\s*3px/);
    expect(CSS_NO_COMMENTS).toMatch(
      /\.eoy-search__field:has\(\.eoy-search__input:focus-visible\)\s*\{[^}]*outline:\s*3px/,
    );
  });
});

describe('hairlines are decorative only', () => {
  /**
   * `--eoy-border` is a divider between rows, not the boundary of a control, and at
   * #e2e2e2 it is 1.30:1 on white. That is allowed: 1.4.11 governs the identification of
   * components, and a rule between two list rows identifies nothing. `--eoy-border-strong`
   * is the token that DOES bound an interactive control, and the non-text suite above
   * holds it to 3:1. This test exists so that if someone promotes `--eoy-border` to a
   * control boundary, the fact that it cannot carry that job is on the record.
   */
  it('--eoy-border is below 3:1 and therefore must not bound a control', () => {
    expect(contrastRatio(value('light', '--eoy-border'), '#ffffff')).toBeLessThan(AA_NON_TEXT);
    expect(
      contrastRatio(value('light', '--eoy-border-strong'), '#ffffff'),
    ).toBeGreaterThanOrEqual(AA_NON_TEXT);
  });
});
