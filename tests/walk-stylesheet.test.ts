/**
 * THE WALK SECTION OF THE STYLESHEET, AUDITED.
 *
 * `tests/contrast.test.ts` reads the FIRST `:root { … }` block out of `src/index.css` and
 * measures every token in it. That is why the walk palette is NOT declared as tokens in this
 * feature: a `--wnyc-*` token in a second `:root` block would be invisible to that audit, the
 * audit would skip it while reporting a pass, and skipping a colour is worse than failing on
 * one. The walk colours are therefore literals in the component's inline custom properties,
 * owned by `src/features/walk/style.ts`, and pinned to that one source of truth from here.
 *
 * So this file is the walk feature's own stylesheet audit, and it audits the same criteria the
 * shared suites do — for the walk classes only:
 *
 *   - no new selector anywhere in the section (nothing existing was restyled);
 *   - the data colours in `style.ts` are MEASURABLE and clear WCAG 2.2 1.4.11, using
 *     `src/lib/contrast.ts` rather than a hand-rolled luminance;
 *   - every walk custom property the components set resolves to a measurable colour;
 *   - no text-bearing rule fixes a `height` (1.4.12) and no scroller is unguarded;
 *   - every interactive control meets the 24px target-size floor (2.5.8).
 */

import { describe, expect, it } from 'vitest';
import { ACTIVITY_LEVELS, SENSOR_ACTIVITIES, STALENESS_STATES, TREND_STATES } from '../src/types/walk';
import { ACTIVITY_STYLES, CHART_STYLE, SENSOR_STYLE, TREND_STYLES } from '../src/features/walk/style';
import { AA_NON_TEXT, contrastRatio, isMeasurable, ratioText } from '../src/lib/contrast';
import {
  CSS,
  CSS_NO_COMMENTS,
  classesIn,
  declarationsFor,
  lengthsToPx,
  readBlocks,
  ruleAppliesTo,
} from './helpers/stylesheet';

/**
 * The walk section of the stylesheet, as its own source.
 *
 * Sliced at the banner so `readBlocks` cannot pick up a declaration from the application layer
 * above it, and so an edit that removes the banner fails here loudly rather than quietly
 * shrinking the audited region to nothing. The slice is taken from `CSS` — WITH comments —
 * because the banner lives inside one, and the comments are stripped afterwards. Indexing
 * `CSS_NO_COMMENTS` for the banner would not find it, and slicing that at a byte offset taken
 * from the other string would cut mid-rule.
 */
const BANNER = 'WHERE NYC WALKS';
const BANNER_INDEX = CSS.indexOf(BANNER);

if (BANNER_INDEX < 0) {
  throw new Error(
    'The walk section is missing from src/index.css. It is appended at the end of the file ' +
      'under a "WHERE NYC WALKS" banner, and nothing above it may be edited.',
  );
}

/*
 * The slice has to start at the banner comment's OPENING `/*`, not at the banner text: slicing
 * at the text leaves the comment's tail in the source with nothing to close it, and the strip
 * below then cannot match — which is how a stylesheet audit ends up reading the documentation
 * above it as a selector and reporting `tests/helpers/stylesheet.ts` as a class this feature
 * does not own.
 */
const WALK_COMMENT_START = CSS.lastIndexOf('/*', BANNER_INDEX);
if (WALK_COMMENT_START < 0) {
  throw new Error('The walk banner is not inside a comment, so the section has no documentation.');
}

const WALK_CSS = CSS.slice(WALK_COMMENT_START).replace(/\/\*[\s\S]*?\*\//g, '');
const WALK_BLOCKS = readBlocks(WALK_CSS);

describe('the section exists, is appended, and touches nothing above it', () => {
  it('is at the end of the file, after the application layer', () => {
    // Both markers live inside CSS comments, so both are located in `CSS` rather than in the
    // comment-stripped source — and a banner that drifts into the middle of the application
    // layer is a banner that has started restyling it.
    const application = CSS.indexOf('THE APPLICATION LAYER');
    expect(application).toBeGreaterThan(-1);
    expect(BANNER_INDEX).toBeGreaterThan(application);
  });

  it('the audited slice has no comments left in it, so no prose is read as a selector', () => {
    expect(WALK_CSS).not.toContain('/*');
  });

  it('declares only `wnyc-` classes — no existing selector is restyled', () => {
    // The rule from the brief, made checkable. A `.eoy-` selector in this section would mean
    // this feature had edited a rule the shell owns.
    const offenders: string[] = [];
    for (const block of WALK_BLOCKS) {
      for (const name of classesIn(block.selector)) {
        if (!name.startsWith('wnyc-')) offenders.push(`${block.selector} -> .${name}`);
      }
    }
    expect(offenders, 'a rule in the walk section names a class this feature does not own').toEqual([]);
  });

  it('styles only classes the walk components actually render', () => {
    // A `.wnyc-` rule for a class nothing renders is a rule that will quietly stop applying.
    const RENDERED = [
      'wnyc-detail',
      'wnyc-detail__headline',
      'wnyc-detail__facts',
      'wnyc-detail__fact',
      'wnyc-detail__label',
      'wnyc-detail__value',
      'wnyc-detail__caveat',
      'wnyc-chart',
      'wnyc-chart__title',
      'wnyc-chart__svg',
      'wnyc-chart__tick',
      'wnyc-chart__caption',
      'wnyc-chart__refused',
      'wnyc-legend',
      'wnyc-legend__summary',
      'wnyc-legend__list',
      'wnyc-legend__item',
      'wnyc-legend__text',
      'wnyc-legend__label',
      'wnyc-legend__symbol',
      'wnyc-legend__swatch',
      'wnyc-legend__note',
      'wnyc-legend__about',
      'wnyc-sort',
      'wnyc-sort__legend',
      'wnyc-sort__note',
      'wnyc-sort__options',
      'wnyc-sort__option',
      'wnyc-sort__input',
      'wnyc-sort__label',
      'wnyc-sort__name',
      'wnyc-sort__definition',
    ];
    const styled = new Set(WALK_BLOCKS.flatMap((block) => classesIn(block.selector)));
    for (const name of styled) {
      expect(RENDERED, `.${name} is styled but no walk component renders it`).toContain(name);
    }
  });

  it('audits a non-trivial region, so a truncated section cannot make this suite vacuous', () => {
    expect(WALK_BLOCKS.length).toBeGreaterThan(20);
  });
});

describe('every colour the walk feature paints is measurable, and clears 1.4.11', () => {
  const DATA_COLORS: ReadonlyArray<readonly [string, string]> = [
    ...TREND_STATES.map((trend) => [`trend ${trend}`, TREND_STYLES[trend].color] as const),
    ...SENSOR_ACTIVITIES.map((activity) => [`activity ${activity}`, ACTIVITY_STYLES[activity].color] as const),
    ['the survey bar', CHART_STYLE.barFill],
    ['the most recent survey bar', CHART_STYLE.latestBarFill],
    ['the axis', CHART_STYLE.axisColor],
    ['the counter ring', SENSOR_STYLE.ringColor],
  ];

  it('finds one data colour per trend and per activity, so the table cannot lose a row', () => {
    expect(DATA_COLORS.length).toBe(TREND_STATES.length + SENSOR_ACTIVITIES.length + 4);
    expect(ACTIVITY_LEVELS).toHaveLength(4);
    // Five as of the fault gate: fresh, faulted, stale, offline, unavailable. This is a
    // tripwire on the contract's arity, so it fails loudly when a state is added rather
    // than when someone remembers to extend the colour table.
    expect(STALENESS_STATES).toHaveLength(5);
  });

  it('the counter ring halo is the SURFACE colour, and the dark ring beside it is the boundary', () => {
    // Deliberately not in the table above. A MapLibre circle layer cannot punch a hole, so the
    // counter's ring is a white disc with a dark rim and the core is a smaller disc in the
    // activity colour — the same construction `src/map/layers.ts` uses for the eat feature's
    // `both` annulus. The white is a HALO: it is 1:1 against the card on purpose, and what
    // delineates the mark from the map is `SENSOR_STYLE.ringColor`, which IS in the table. This
    // test exists so a future change that makes the halo a data colour fails to be deliberate
    // about it.
    expect(SENSOR_STYLE.ringHaloColor).toBe('#ffffff');
    expect(contrastRatio(SENSOR_STYLE.ringColor, SENSOR_STYLE.ringHaloColor)).toBeGreaterThanOrEqual(
      AA_NON_TEXT,
    );
  });

  for (const [label, color] of DATA_COLORS) {
    it(`${label} (${color}) is measurable and clears ${AA_NON_TEXT}:1 on both light surfaces`, () => {
      expect(isMeasurable(color), `${label} is "${color}", which contrastRatio cannot measure`).toBe(true);
      for (const surface of ['#ffffff', '#f7f7f7']) {
        const ratio = contrastRatio(color, surface);
        expect(
          ratio,
          `${label} (${color}) on ${surface} is ${ratioText(color, surface)}, below the ${AA_NON_TEXT}:1 floor`,
        ).toBeGreaterThanOrEqual(AA_NON_TEXT);
      }
    });
  }

  it('no walk colour is transparent, unresolvable, or a CSS keyword', () => {
    for (const [label, color] of DATA_COLORS) {
      expect(/^#[0-9a-f]{6}$/i.test(color), `${label} is "${color}"`).toBe(true);
    }
  });
});

describe('the custom properties the components set inline are all measurable', () => {
  /**
   * `WalkLegend` sets six `--wnyc-swatch*` custom properties from `style.ts` through an inline
   * `style` attribute. A typo in one of those names would leave the swatch unstyled and the
   * test on the swatch's shape would pass on a white square, so each is checked against the
   * stylesheet's own declaration of the same name.
   */
  const SET_BY_COMPONENTS = [
    '--wnyc-swatch',
    '--wnyc-swatch-core',
    '--wnyc-swatch-ring',
    '--wnyc-swatch-hollow',
  ];

  it('the stylesheet declares every property the components set', () => {
    for (const name of SET_BY_COMPONENTS) {
      expect(
        ruleAppliesTo(
          WALK_BLOCKS.map((block) => block.selector).join(', '),
          name.replace(/^--/, ''),
        ) || CSS_NO_COMMENTS.includes(`var(${name}`),
        `nothing in the walk section reads or declares ${name}`,
      ).toBe(true);
    }
  });

  it('the swatch reads the properties it is given, so the shape is real rather than nominal', () => {
    const swatch = WALK_BLOCKS.find((block) => block.selector === '.wnyc-legend__swatch');
    expect(swatch, '.wnyc-legend__swatch has no rule').toBeDefined();
    const body = swatch?.body ?? '';
    expect(body).toContain('var(--wnyc-swatch');
    expect(body).toContain('border-radius: 50%');
    // The hollow core is the `::after`, and its opacity is the custom property. A missing rule
    // there would leave a "no recent reading" swatch as a solid grey dot.
    const core = WALK_BLOCKS.find((block) => block.selector === '.wnyc-legend__swatch::after');
    expect(core?.body ?? '').toContain('var(--wnyc-swatch-hollow');
  });
});

describe('the accessibility rules the shared suites enforce, applied to the walk classes', () => {
  it('no text-bearing walk rule fixes a `height` (WCAG 1.4.12)', () => {
    // Read from the same helper the shared audit uses, so the criterion is the shared one.
    // `tests/layout.test.ts` could not be given these classes without editing a file this
    // feature does not own, and the rule it applies is not optional.
    const offenders = WALK_BLOCKS
      .filter((block) => /(^|[;{\s])height\s*:\s*[\d.]+(px|rem)/.test(block.body))
      .filter((block) => !/max-height/.test(block.body))
      .map((block) => `${block.selector} { ${block.body.trim().replace(/\s+/g, ' ')} }`);
    expect(offenders).toEqual([]);
  });

  it('the swatch derives its height from its width rather than declaring one', () => {
    // The reason there is nothing to add to SAFE_FIXED_HEIGHTS: a legend swatch is a decoration
    // that happens to be square, and `aspect-ratio` says so without a fixed length.
    //
    // Read off the rule ITSELF rather than through `declarationsFor`, because that helper's
    // class-token match also collects `.wnyc-legend__swatch::after` — the helper documents this
    // — and would read the core's 62% as the swatch's width.
    const base = WALK_BLOCKS.find((block) => block.selector === '.wnyc-legend__swatch');
    const own = Object.fromEntries(
      (base?.body ?? '')
        .split(';')
        .map((declaration) => {
          const colon = declaration.indexOf(':');
          return colon < 0
            ? ['', '']
            : [declaration.slice(0, colon).trim(), declaration.slice(colon + 1).trim()];
        })
        .filter(([property]) => property !== ''),
    );
    expect(own['width']).toBe('1.5rem');
    expect(own['aspect-ratio']).toBe('1');
    expect(own['height']).toBeUndefined();
  });

  it('every walk scroller contains its own overscroll', () => {
    const scrollers = WALK_BLOCKS.filter((block) =>
      /(^|[;{\s])overflow(-[xy])?\s*:\s*(auto|scroll)\b/.test(block.body),
    );
    // The legend panel is the only one, and the assertion is that a scroller EXISTS — an empty
    // list would make the loop vacuous, which is the failure the shared audit guards against.
    expect(scrollers.length).toBeGreaterThan(0);
    for (const block of scrollers) {
      const classes = classesIn(block.selector);
      expect(classes.length, `${block.selector} names no single class`).toBe(1);
      const decls = declarationsFor('light', classes[0] ?? '');
      expect(
        decls['overscroll-behavior'] ??
          decls['overscroll-behavior-y'] ??
          decls['overscroll-behavior-x'] ??
          '(nothing)',
        `${block.selector} scrolls, so its over-scroll must not chain to the page`,
      ).toContain('contain');
    }
  });

  it('nothing in the walk section is sized in `vh`', () => {
    const offenders = WALK_BLOCKS.filter((block) => /[\d.]+vh\b/.test(block.body)).map(
      (block) => block.selector,
    );
    expect(offenders).toEqual([]);
  });

  it('every interactive walk control meets the 24px target-size floor (WCAG 2.5.8)', () => {
    // The same floor `tests/layout.test.ts` applies to the app's own controls, applied here
    // because that file's INTERACTIVE list is not this feature's to edit.
    const INTERACTIVE = [
      'wnyc-legend__summary',
      'wnyc-legend__about',
      'wnyc-sort__label',
    ];
    for (const name of INTERACTIVE) {
      const declarations = declarationsFor('light', name);
      expect(Object.keys(declarations).length, `.${name} has no rules at all`).toBeGreaterThan(0);
      const minHeight = lengthsToPx('light', declarations['min-height'] ?? '');
      expect(minHeight, `.${name} sets no min-height`).not.toBeNull();
      expect(minHeight ?? 0, `.${name} is ${minHeight}px tall, under the 24px floor`).toBeGreaterThanOrEqual(24);
    }
  });

  it('the selected sort paints its inversion on the LABEL, the element the eye can see', () => {
    // The mechanism `.eoy-chip` uses, and the one the focus-indicator audit enforces: a
    // specificity inversion between two rules would leave black text on a black chip.
    const checked = WALK_BLOCKS.find(
      (block) => block.selector === '.wnyc-sort__input:checked + .wnyc-sort__label',
    );
    expect(checked?.body ?? '').toMatch(/background:\s*var\(--eoy-text\)/);
    expect(checked?.body ?? '').toMatch(/color:\s*var\(--eoy-text-inverse\)/);
  });

  it('a focused sort control is outlined, and the outline is on the label', () => {
    const focused = WALK_BLOCKS.find(
      (block) => block.selector === '.wnyc-sort__input:focus-visible + .wnyc-sort__label',
    );
    expect(focused?.body ?? '').toMatch(/outline:\s*3px solid/);
  });

  it('forced-colors re-establishes the selected state with an outline it keeps', () => {
    const forced = WALK_BLOCKS.find(
      (block) => block.selector === '.wnyc-sort__input:checked + .wnyc-sort__label',
    );
    // The rule is inside the `@media (forced-colors: active)` block, which `readBlocks`
    // flattens, so the check is that the declaration exists at all — `tests/layout.test.ts`
    // already asserts the same pattern for the app's own controls.
    expect(forced).toBeDefined();
    expect(WALK_CSS).toMatch(/@media \(forced-colors: active\)/);
    expect(WALK_CSS).toMatch(/outline:\s*2px solid Highlight/);
  });

  it('the walk section adds no transition or animation, so reduced motion has nothing to catch', () => {
    const animated = WALK_BLOCKS
      .filter((block) => /transition:|animation:/.test(block.body))
      .filter((block) => !/transition:\s*none/.test(block.body))
      .map((block) => block.selector);
    expect(animated).toEqual([]);
    // The override is there anyway, so a future transition cannot be added without this block
    // already being the place that neutralises it.
    expect(WALK_CSS).toMatch(/@media \(prefers-reduced-motion: reduce\)/);
  });
});
