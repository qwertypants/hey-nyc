/**
 * STYLESHEET TEST HELPERS.
 *
 * The colour audit and the layout-resilience audit both need to read `src/index.css` the way
 * a browser does: resolve `var()` chains, apply the media queries that are in force, and hand
 * back declarations per selector. Doing that twice would mean two parsers that could disagree
 * with each other — and the worst version of that is one of them quietly measuring nothing
 * while still reporting a pass.
 *
 * So it lives here, once, and both suites use it.
 *
 * Public surface:
 *   CSS, CSS_NO_COMMENTS
 *   Scheme, SCHEMES, palette(scheme), token(scheme, name), resolve(scheme, value)
 *   readBlocks(source): { selector, body }[]
 *   ruleAppliesTo(selector, className): boolean
 *   declarationsFor(scheme, className): Record<string, string>
 *   lengthsToPx(scheme, value): number | null
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';

/*
 * Resolved from the Vitest project root, not from `__dirname` and not from `import.meta.url`.
 * Both were tried: a helper under `tests/helpers/` is transformed as ESM, where `__dirname`
 * arrives as an empty string — which does not throw, it just silently resolves to
 * `../../src/index.css` and fails with an ENOENT two frames away — and under Vitest
 * `import.meta.url` is not a `file:` URL at all, so `fileURLToPath` rejects it. The root is
 * the one location both environments agree on, and the guard below turns any future breakage
 * into a message that names the file instead of a bare ENOENT.
 */
const STYLESHEET = resolvePath(process.cwd(), 'src/index.css');
if (!existsSync(STYLESHEET)) {
  throw new Error(
    `Could not find src/index.css at ${STYLESHEET}. The stylesheet audits are rooted at the ` +
      'Vitest project root; run them with `npm test` from the repository root.',
  );
}

export const CSS = readFileSync(STYLESHEET, 'utf8');

/** Comments carry documentation that itself contains hex values, so they go first. */
export const CSS_NO_COMMENTS = CSS.replace(/\/\*[\s\S]*?\*\//g, '');

export type Scheme = 'light' | 'dark' | 'enhanced light' | 'enhanced dark';

export const SCHEMES: readonly Scheme[] = ['light', 'dark', 'enhanced light', 'enhanced dark'];

/** Every `--token: value;` declaration inside the first block matching `open`. */
function tokensIn(
  open: string,
  close: string,
  from: number,
  source: string,
): Record<string, string> {
  const start = source.indexOf(open, from);
  if (start < 0) throw new Error(`could not find "${open}" in src/index.css`);
  const end = source.indexOf(close, start);
  if (end < start) throw new Error(`could not find the closing "${close}" after "${open}"`);
  const out: Record<string, string> = {};
  for (const match of source.slice(start, end).matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    const name = match[1];
    const value = match[2];
    if (name !== undefined && value !== undefined) out[name] = value.trim();
  }
  return out;
}

/**
 * `prefers-contrast: more` is REMOVED before the base schemes are read. It is a user override
 * layered on top of whichever scheme is active, so folding it into the base `--eoy-text-muted`
 * would make the light scheme report the enhanced value and the audit would pass on a palette
 * the default user never sees.
 */
const WITHOUT_ENHANCED = CSS_NO_COMMENTS.replace(
  /@media \(prefers-contrast: more\) \{[\s\S]*?\n\}\n/,
  '',
);

const LIGHT = tokensIn(':root {', '}', 0, WITHOUT_ENHANCED);
const DARK_RAW = tokensIn('@media (prefers-color-scheme: dark) {', '\n}', 0, WITHOUT_ENHANCED);

const ENHANCED_START = CSS_NO_COMMENTS.indexOf('@media (prefers-contrast: more) {');
const ENHANCED_LIGHT_RAW = tokensIn(
  '@media (prefers-contrast: more) {',
  '@media (prefers-color-scheme: dark) {',
  0,
  CSS_NO_COMMENTS,
);
/**
 * The nested dark block INSIDE the enhanced block. Read separately because the outer block's
 * light values are still in force for a user who wants enhanced contrast in a dark scheme
 * until this one overrides them — and the whole point of the nested block is that it has to.
 */
const ENHANCED_DARK_RAW = tokensIn(
  '@media (prefers-color-scheme: dark) {',
  '\n}',
  ENHANCED_START,
  CSS_NO_COMMENTS,
);

export function palette(scheme: Scheme): Record<string, string> {
  switch (scheme) {
    case 'light':
      return LIGHT;
    case 'dark':
      return { ...LIGHT, ...DARK_RAW };
    case 'enhanced light':
      return { ...LIGHT, ...ENHANCED_LIGHT_RAW };
    case 'enhanced dark':
      return { ...LIGHT, ...DARK_RAW, ...ENHANCED_LIGHT_RAW, ...ENHANCED_DARK_RAW };
  }
}

export function token(scheme: Scheme, name: string): string {
  const found = palette(scheme)[name];
  if (found === undefined) throw new Error(`--${name} is not defined in the ${scheme} scheme`);
  return found;
}

/**
 * Resolves `var()` chains the way the cascade does — innermost first, repeatedly, until the
 * value stops changing. A reference to a token that does not exist is left as-is rather than
 * dropped, so a typo shows up as unresolvable text instead of silently becoming "inherit".
 */
export function resolve(scheme: Scheme, input: string, depth = 0): string {
  if (depth > 10) return input;
  const next = input.replace(/var\((--[\w-]+)\)/g, (whole, name: string) => {
    const found = palette(scheme)[name];
    return found === undefined ? whole : found;
  });
  return next === input ? next : resolve(scheme, next, depth + 1);
}

export interface Block {
  readonly selector: string;
  readonly body: string;
}

/**
 * Every top-level rule in the source, in order, with its media-query context noted in the
 * selector. Nested `@media` blocks are flattened, because a declaration inside one still
 * applies — it just applies under a condition, and these audits are about whether the
 * declaration is SAFE, not whether it is always on.
 */
export function readBlocks(source: string = CSS_NO_COMMENTS): Block[] {
  const blocks: Block[] = [];
  // Strip @keyframes bodies: they are not selectors and their percentages are not targets.
  const withoutKeyframes = source.replace(/@keyframes[\s\S]*?\n\}/g, '');
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let match: RegExpExecArray | null = re.exec(withoutKeyframes);
  while (match !== null) {
    const selector = match[1];
    const body = match[2];
    if (selector !== undefined && body !== undefined && !selector.trim().startsWith('@')) {
      blocks.push({ selector: selector.trim(), body });
    }
    match = re.exec(withoutKeyframes);
  }
  return blocks;
}

/**
 * Whether a rule's selector can match the element carrying `className`.
 *
 * This is deliberately a CLASS-TOKEN test, not a substring test. Substring matching is how
 * the first version of the layout audit reported `.eoy-chip` as being 1px tall: it matched
 * `.eoy-chip input`, the visually-hidden radio, and inherited that sliver's height. It also
 * made `.eoy-search` pick up `.eoy-search__field`'s declarations, and `.eoy-app` pick up
 * `.eoy-app__body`'s. Each of those produced a confident, wrong failure — which is worse than
 * no audit, so the matching is exact: a compound selector counts only if it contains this
 * class as a whole `.foo` token.
 */
export function ruleAppliesTo(selector: string, className: string): boolean {
  const target = `.${className}`;
  return selector.split(',').some((compound) => {
    /*
     * Only the SUBJECT of the chain can be the element itself. `.eoy-chip input` styles an
     * input inside a chip, not the chip, so `.eoy-chip` must not count as matched by it.
     * Descendant, child and sibling combinators all end the subject, so the last part is the
     * one to look at.
     */
    const parts = compound.trim().split(/\s*[>+~]\s*|\s+/).filter((p) => p !== '');
    const subject = parts[parts.length - 1];
    if (subject === undefined) return false;
    // Functional pseudo-classes may themselves name classes, and those are not this element.
    const withoutFunctionalPseudos = subject.replace(/:(has|is|where|not)\([^)]*\)/g, '');
    /*
     * Class TOKENS, not a substring. `.eoy-app__body` contains the characters ".eoy-app", so
     * an `includes` test reported `.eoy-app` as `position: relative` — it read the body's
     * declaration and then failed to prove the shell is `position: fixed`. Same trap for
     * `.eoy-pill` against `.eoy-pill--on-dark`.
     */
    const tokens = [...withoutFunctionalPseudos.matchAll(/\.([A-Za-z][\w-]*)/g)].map((m) => m[1]);
    return tokens.includes(className) || withoutFunctionalPseudos === target;
  });
}

/** Declarations of a rule whose selector is a bare ELEMENT, e.g. `body`. */
export function elementDeclarations(element: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const block of readBlocks()) {
    const subjects = block.selector.split(',').map((c) => c.trim());
    if (!subjects.includes(element)) continue;
    for (const decl of block.body.split(';')) {
      const colon = decl.indexOf(':');
      if (colon < 0) continue;
      const property = decl.slice(0, colon).trim();
      const value = decl.slice(colon + 1).trim();
      if (property !== '' && value !== '') out[property] = value;
    }
  }
  return out;
}

/**
 * The declarations that apply to an element carrying `className`, with later rules winning —
 * the same order the cascade would use for equal specificity. Later is not always right once
 * specificity is involved; these audits deliberately read the last word and treat a
 * specificity inversion as something to notice, not to resolve.
 */
export function declarationsFor(scheme: Scheme, className: string): Record<string, string> {
  void scheme;
  const out: Record<string, string> = {};
  for (const block of readBlocks()) {
    if (!ruleAppliesTo(block.selector, className)) continue;
    for (const decl of block.body.split(';')) {
      const colon = decl.indexOf(':');
      if (colon < 0) continue;
      const property = decl.slice(0, colon).trim();
      const value = decl.slice(colon + 1).trim();
      if (property !== '' && value !== '') out[property] = value;
    }
  }
  return out;
}

/** Every class token that appears in a rule's selector. */
export function classesIn(selector: string): string[] {
  const out: string[] = [];
  for (const match of selector.matchAll(/\.([A-Za-z][\w-]*)/g)) {
    if (match[1] !== undefined) out.push(match[1]);
  }
  return out;
}

const REM = 16;

/**
 * Resolves a CSS length to CSS pixels, or null when it is not a length this can judge.
 * `rem` uses the 16px root assumption the whole token set is written in, which is why every
 * size in `src/index.css` is in `rem` rather than `px`.
 */
export function lengthsToPx(scheme: Scheme, value: string): number | null {
  const raw = resolve(scheme, value).trim();
  const calc = /^calc\((.*)\)$/.exec(raw);
  if (calc !== null) {
    // Only the additive form this stylesheet uses: sum every term and ignore operators.
    const terms = [...(calc[1] ?? '').matchAll(/([\d.]+)\s*(px|rem|em)/g)];
    if (terms.length === 0) return null;
    let total = 0;
    for (const term of terms) {
      const n = Number(term[1]);
      const unit = term[2];
      if (unit === 'px') total += n;
      else if (unit === 'rem' || unit === 'em') total += n * REM;
      else return null;
    }
    return total;
  }
  const single = /^([\d.]+)\s*(px|rem|em|pt)?$/.exec(raw);
  if (single === null) return null;
  const n = Number(single[1]);
  switch (single[2]) {
    case undefined:
    case 'px':
      return n;
    case 'rem':
    case 'em':
      return n * REM;
    case 'pt':
      return (n * 96) / 72;
    default:
      return null;
  }
}
