/**
 * THE DOCUMENT HEAD.
 *
 * `theme-color` is the one part of the design system that cannot live in `src/index.css`: a
 * meta tag reads no custom property, so the hexes in `index.html` are necessarily a hand-copy
 * of something the stylesheet owns. A copy is only safe if it fails loudly when it drifts —
 * a browser paints the toolbar and no review sees the mismatch, which is how `#1b1b1f` came
 * to sit there: a colour that is neither the header's black nor either `--eoy-bg`, matching
 * nothing in the app.
 *
 * So the expected values are READ OUT of the stylesheet through the shared helper rather than
 * written down here, and the structural assertions are the ones that catch a regression:
 * exactly two media-scoped metas, none unmediated to shadow them, light first.
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Scheme } from './helpers/stylesheet';
import { declarationsFor, resolve } from './helpers/stylesheet';

/*
 * Rooted at the Vitest project root for the reason `tests/helpers/stylesheet.ts` documents:
 * the guard turns a misrooted run into a sentence naming the file instead of a bare ENOENT
 * thrown from inside an expect.
 */
const INDEX = resolvePath(process.cwd(), 'index.html');
if (!existsSync(INDEX)) {
  throw new Error(
    `Could not find index.html at ${INDEX}. This audit is rooted at the Vitest project ` +
      'root; run it with `npm test` from the repository root.',
  );
}

/** The head's own comment explains the hexes, and a comment may quote a tag verbatim. */
const HEAD = readFileSync(INDEX, 'utf8').replace(/<!--[\s\S]*?-->/g, '');

const LIGHT = '(prefers-color-scheme: light)';
const DARK = '(prefers-color-scheme: dark)';

interface ThemeColor {
  readonly content: string;
  /** `null` when the tag carries no `media` — the case that shadows the scoped ones. */
  readonly media: string | null;
}

function themeColors(): ThemeColor[] {
  const found: ThemeColor[] = [];
  // `[^>]*` spans newlines, so a tag broken across three lines is still one match.
  for (const tag of HEAD.match(/<meta\b[^>]*>/g) ?? []) {
    if (!/\sname=["']theme-color["']/.test(tag)) continue;
    const content = /\scontent=["']([^"']*)["']/.exec(tag)?.[1];
    if (content === undefined) continue;
    found.push({ content, media: /\smedia=["']([^"']*)["']/.exec(tag)?.[1] ?? null });
  }
  return found;
}

/**
 * The colour the browser UI is painted, read from the stylesheet rather than written here.
 *
 * It is the HEADER, not `--eoy-bg`. `.eoy-app` is `position: fixed; inset: 0` and
 * `.eoy-app__body` is a grid whose first row is the header, so the top edge of the screen is
 * `.eoy-header` in both schemes — and the header is black by design, with a comment in the
 * stylesheet saying so. `--eoy-bg` is what fills the rest of the shell; in the light scheme
 * that is near-white, and a near-white toolbar butted against a black bar is the worse of the
 * two mistakes. Resolving through the helper means a header that is ever tokenised moves this
 * expectation with it, in whichever scheme it flips.
 */
function chromeColour(scheme: Scheme): string {
  const background = declarationsFor(scheme, 'eoy-header')['background'];
  if (background === undefined) {
    throw new Error(`.eoy-header sets no background in src/index.css (${scheme} scheme)`);
  }
  return resolve(scheme, background);
}

describe('the head declares the browser chrome colour for both colour schemes', () => {
  it('declares exactly two theme-color tags, the light one first', () => {
    // Position in the document is a behaviour, not a style: a browser that does not implement
    // `media` on this element takes the FIRST one it finds.
    expect(themeColors().map((meta) => meta.media)).toEqual([LIGHT, DARK]);
  });

  it('paints the light-scheme chrome the colour the header is', () => {
    const scoped = themeColors().filter((meta) => meta.media === LIGHT);
    expect(scoped.map((meta) => meta.content)).toEqual([chromeColour('light')]);
  });

  it('paints the dark-scheme chrome the colour the header is', () => {
    const scoped = themeColors().filter((meta) => meta.media === DARK);
    expect(scoped.map((meta) => meta.content)).toEqual([chromeColour('dark')]);
  });

  it('leaves no unmediated theme-color to shadow the scoped ones', () => {
    // This is the regression worth catching. A `theme-color` with no `media` is not merely a
    // duplicate: re-adding the old single tag puts a hard-coded colour back in charge of the
    // toolbar and the two scoped ones stop being what anyone sees.
    const unmediated = themeColors().filter((meta) => meta.media === null);
    expect(unmediated.map((meta) => meta.content)).toEqual([]);
  });

  it('has a header colour that does not flip between schemes, because the header does not', () => {
    // Not a tautology: the day the header is tokenised so it flips, these two hexes have to
    // become different, and this is the assertion that says so out loud.
    expect(chromeColour('dark')).toBe(chromeColour('light'));
  });
});
