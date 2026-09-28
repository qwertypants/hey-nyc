/**
 * INTEGRATION NOTES (src/lib/contrast.ts)
 *
 * WCAG 2.2 contrast maths, in one place, so "is this colour combination accessible?" is a
 * question with an answer rather than an opinion. It exists because the honest way to claim
 * ADA / WCAG conformance is to MEASURE every pair in the palette and fail the build when
 * one drifts — see `tests/contrast.test.ts`, which walks the real tokens out of
 * `src/index.css` and `src/map/style.ts` and asserts each ratio against its threshold.
 *
 * Nothing here knows about the app. It is pure functions over hex strings, which is what
 * makes it safe to import from a test without pulling React, MapLibre or jsdom in.
 *
 * THE THRESHOLDS (WCAG 2.2, "Web Content Accessibility Guidelines")
 *   1.4.3  Contrast (Minimum), AA        4.5:1  body text
 *   1.4.3  Contrast (Minimum), AA Large  3:1   text >= 18.66px bold or >= 24px
 *   1.4.11 Non-text Contrast, AA         3:1   UI component boundaries, icon strokes,
 *                                               focus indicators, meaningful graphics
 *   1.4.6  Contrast (Enhanced), AAA       7:1   optional; asserted for the primary ink pair
 *
 * Public surface:
 *   relativeLuminance(hex): number
 *   contrastRatio(a: string, b: string): number
 *   AA_TEXT, AA_LARGE_TEXT, AA_NON_TEXT, AAA_TEXT
 */

export const AA_TEXT = 4.5;
export const AA_LARGE_TEXT = 3;
export const AA_NON_TEXT = 3;
export const AAA_TEXT = 7;

interface Rgb {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

const SHORT_HEX = /^#([\da-f])([\da-f])([\da-f])$/i;
const LONG_HEX = /^#([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i;
const RGB_FN = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i;
/*
 * The alpha channel, in BOTH the legacy comma form and the CSS Color 4 slash form, and in both
 * `rgba(...)` and `rgb(...)` spellings — `rgb(255 255 255 / 14%)` is what this stylesheet
 * writes, and it is why this is not `/^rgba\(/`.
 *
 * An earlier version of this matched only `rgba(`, so `rgb(r g b / a)` fell through to
 * RGB_FN, which stops reading after the third channel and returned the colour at full
 * strength. Every translucent pair in the palette then measured as opaque white on black —
 * 21:1, comfortably passing — so `flatten` was a no-op on exactly the values it exists to
 * measure, and the audit it guarded could not have failed. The failure was not a wrong number
 * but an absent one.
 */
const ALPHA_CHANNEL = /[,/]\s*([\d.]+%?)\s*\)\s*$/i;

/**
 * Reads a capture group that the caller has already established exists by matching. Written
 * out once so every parse site stays free of non-null assertions under
 * `noUncheckedIndexedAccess`.
 */
function group(match: RegExpExecArray, index: number): string {
  const value = match[index];
  if (value === undefined) throw new Error(`Regex group ${index} missing from ${match[0]}`);
  return value;
}

/** The three hex digits of `#rgb`, as 0–255 channels. */
function fromShortHex(match: RegExpExecArray): Rgb {
  return {
    r: Number.parseInt(group(match, 1).repeat(2), 16),
    g: Number.parseInt(group(match, 2).repeat(2), 16),
    b: Number.parseInt(group(match, 3).repeat(2), 16),
  };
}

/** The three byte pairs of `#rrggbb`, as 0–255 channels. */
function fromLongHex(match: RegExpExecArray): Rgb {
  return {
    r: Number.parseInt(group(match, 1), 16),
    g: Number.parseInt(group(match, 2), 16),
    b: Number.parseInt(group(match, 3), 16),
  };
}

/**
 * Parses `#rgb`, `#rrggbb` and the `rgb(r g b / a)` form. Returns null for anything else,
 * including the many CSS keywords in play — a token that fails to parse is a token the
 * audit must fail loudly on, not silently skip.
 */
export function parseColor(input: string): Rgb | null {
  const value = input.trim();
  const short = SHORT_HEX.exec(value);
  if (short !== null) return fromShortHex(short);
  const long = LONG_HEX.exec(value);
  if (long !== null) return fromLongHex(long);
  const fn = RGB_FN.exec(value);
  if (fn !== null) {
    return { r: Number(group(fn, 1)), g: Number(group(fn, 2)), b: Number(group(fn, 3)) };
  }
  return null;
}

/** One sRGB channel, 0–255, linearised per WCAG 2.x. */
function channel(value: number): number {
  const scaled = value / 255;
  return scaled <= 0.04045 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
}

/** WCAG relative luminance, 0 (black) to 1 (white). */
export function relativeLuminance(hex: string): number {
  const rgb = parseColor(hex);
  if (rgb === null) throw new Error(`Not a colour this module can measure: ${hex}`);
  return 0.2126 * channel(rgb.r) + 0.7152 * channel(rgb.g) + 0.0722 * channel(rgb.b);
}

/**
 * WCAG contrast ratio, 1:1 to 21:1. Order-independent, and computed on the colours
 * themselves rather than by guessing which is lighter — that is the whole point, because
 * "is the muted gray light enough" is exactly the judgement this replaces.
 */
export function contrastRatio(foreground: string, background: string): number {
  const a = relativeLuminance(foreground);
  const b = relativeLuminance(background);
  const lighter = Math.max(a, b);
  const darker = Math.min(a, b);
  return (lighter + 0.05) / (darker + 0.05);
}

/** Rounds to 2dp, for a test failure message a human can act on. */
export function ratioText(foreground: string, background: string): string {
  return `${contrastRatio(foreground, background).toFixed(2)}:1 (${foreground} on ${background})`;
}

/** True when a composite (`color-mix`, `rgb(... / 40%)`) cannot be measured as-is. */
export function isMeasurable(value: string): boolean {
  return parseColor(value) !== null;
}

/**
 * The alpha of a `rgb()`/`rgba()` colour as a fraction, or null when the value is not a colour
 * function or carries no alpha. Separate from `flatten` so the "is it translucent at all?"
 * question has one answer rather than being re-derived from a regex at each call site.
 */
function alphaOf(value: string): number | null {
  if (RGB_FN.exec(value) === null) return null;
  const raw = ALPHA_CHANNEL.exec(value)?.[1];
  if (raw === undefined) return null;
  return raw.endsWith('%') ? Number.parseFloat(raw) / 100 : Number(raw);
}

/**
 * Flattens a translucent foreground over an opaque background, so a value like
 * `rgb(255 255 255 / 72%)` is auditable instead of unverifiable. Callers pass the resolved
 * background; returning the composite keeps the caller's assertion readable.
 *
 * MEASURE THE COMPOSITE, ALWAYS. `parseColor` reads a translucent colour as its channels at
 * full strength, so handing `rgb(255 255 255 / 14%)` straight to `contrastRatio` returns the
 * ratio for opaque white — an optimistic answer, never a pessimistic one, which is the worst
 * direction for an audit to be wrong in. Every ratio in the palette is therefore a ratio
 * between two flattened values, and `tests/contrast.test.ts` is where that is enforced.
 */
export function flatten(foreground: string, background: string): string {
  const fraction = alphaOf(foreground.trim());
  if (fraction === null || fraction >= 1) return foreground;
  const under = parseColor(background);
  const over = parseColor(foreground);
  if (under === null || over === null) return foreground;
  const mix = (a: number, b: number): number => Math.round(a * fraction + b * (1 - fraction));
  const hex = (n: number): string => n.toString(16).padStart(2, '0');
  return `#${hex(mix(over.r, under.r))}${hex(mix(over.g, under.g))}${hex(mix(over.b, under.b))}`;
}
