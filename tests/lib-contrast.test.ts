import { describe, expect, it } from 'vitest';
import { AA_TEXT, contrastRatio, flatten, isMeasurable, parseColor, ratioText } from '../src/lib/contrast';

/**
 * DIRECT TESTS FOR src/lib/contrast.ts, which every other suite in the repo leans on for its
 * accessibility claims and which — until these — had no unit tests of its own. `contrast.test.ts`
 * exercises it through the palette, which is the right way to test what the app renders and the
 * wrong way to test a function whose failure mode is silence.
 *
 * The silence is not hypothetical. `flatten` once matched its alpha channel with `/^rgba\(/`,
 * so the `rgb(255 255 255 / 14%)` form this stylesheet actually writes fell through to the
 * opaque parser and was returned unchanged. Every translucent pair in the palette then measured
 * as opaque white on black — 21:1, comfortably passing — so the audit that exists to catch
 * exactly that could not have failed. It was not a wrong number; it was no number.
 */
describe('flatten composites a translucent colour over what is behind it', () => {
  it('the slash form, which is what src/index.css writes', () => {
    expect(flatten('rgb(255 255 255 / 14%)', '#000000')).toBe('#242424');
    expect(flatten('rgb(255 255 255 / 62%)', '#000000')).toBe('#9e9e9e');
    expect(flatten('rgb(255 255 255 / 76%)', '#000000')).toBe('#c2c2c2');
  });

  it('the legacy rgba form, in both spellings', () => {
    expect(flatten('rgba(255, 255, 255, 0.5)', '#000000')).toBe('#808080');
    expect(flatten('rgba(255, 255, 255, 0.5)', '#000000')).toBe('#808080');
  });

  it('a fractional alpha, which the percentage form is not the only way to write', () => {
    expect(flatten('rgba(0, 0, 0, 0.5)', '#ffffff')).toBe('#808080');
    expect(flatten('rgb(0 0 0 / 0.5)', '#ffffff')).toBe('#808080');
  });

  it('composites per channel, not by mixing greys', () => {
    // A 50% red over blue is a purple, and a test written only in greys would not notice an
    // implementation that averaged the luminance instead of blending the channels.
    expect(flatten('rgba(255, 0, 0, 0.5)', '#0000ff')).toBe('#800080');
  });

  it('leaves an opaque colour alone', () => {
    expect(flatten('#ffffff', '#000000')).toBe('#ffffff');
    expect(flatten('rgb(255 255 255)', '#000000')).toBe('rgb(255 255 255)');
  });

  it('is idempotent, so flattening a composite twice changes nothing', () => {
    const once = flatten('rgb(255 255 255 / 14%)', '#000000');
    expect(flatten(once, '#000000')).toBe(once);
  });
});

describe('flatten refuses to invent a colour', () => {
  it('returns the value untouched when the background is not measurable', () => {
    // Silently compositing over nothing would be worse than not compositing: the caller would
    // get a confident hex that no surface in the app actually paints.
    expect(flatten('rgb(255 255 255 / 14%)', 'transparent')).toBe('rgb(255 255 255 / 14%)');
    expect(flatten('rgb(255 255 255 / 14%)', 'color-mix(in srgb, red, blue)')).toBe(
      'rgb(255 255 255 / 14%)',
    );
  });

  it('a keyword is not a colour, and says so by being left alone', () => {
    expect(flatten('currentcolor', '#000000')).toBe('currentcolor');
  });
});

describe('parseColor reads what it is given and refuses the rest', () => {
  it('reads the hex forms, short and long', () => {
    expect(parseColor('#fff')).toEqual({ r: 255, g: 255, b: 255 });
    expect(parseColor('#000000')).toEqual({ r: 0, g: 0, b: 0 });
    expect(parseColor('  #1a1a1a  ')).toEqual({ r: 26, g: 26, b: 26 });
  });

  it('reads both rgb spellings, comma-separated and space-separated', () => {
    expect(parseColor('rgb(255, 255, 255)')).toEqual({ r: 255, g: 255, b: 255 });
    expect(parseColor('rgb(255 255 255)')).toEqual({ r: 255, g: 255, b: 255 });
  });

  /**
   * The trap, stated as a test because it is a property of the API rather than of any one
   * call: a translucent colour parses, and parses as its channels at FULL strength. That is
   * what lets the stylesheet audit accept `rgb(255 255 255 / 28%)` as a colour it can reason
   * about, and it is also why measuring one without flattening it first returns an
   * optimistic ratio. `flatten` before `contrastRatio`, always.
   */
  it('reads a translucent colour at full strength, which is why flatten comes first', () => {
    expect(parseColor('rgb(255 255 255 / 14%)')).toEqual({ r: 255, g: 255, b: 255 });
    expect(contrastRatio('rgb(255 255 255 / 14%)', '#000000')).toBe(21);
    expect(contrastRatio(flatten('rgb(255 255 255 / 14%)', '#000000'), '#000000')).toBeCloseTo(1.35, 2);
  });

  it('returns null for anything it cannot measure', () => {
    for (const value of ['transparent', 'currentcolor', 'Canvas', 'var(--eoy-chip)', '']) {
      expect(parseColor(value), value).toBeNull();
      expect(isMeasurable(value), value).toBe(false);
    }
  });
});

describe('the arithmetic matches the published formula', () => {
  it('the two ends of the scale', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(contrastRatio('#ffffff', '#ffffff')).toBe(1);
  });

  it('is order-independent', () => {
    expect(contrastRatio('#767676', '#ffffff')).toBe(contrastRatio('#ffffff', '#767676'));
  });

  it('the documented 4.5:1 example', () => {
    // #767676 is the canonical grey that just clears 4.5:1 on white, and #949494 is the one
    // just below it — which is why the token set's darkest grey is #6a6a6a and not #999999.
    expect(contrastRatio('#767676', '#ffffff')).toBeGreaterThanOrEqual(AA_TEXT);
    expect(contrastRatio('#949494', '#ffffff')).toBeLessThan(AA_TEXT);
  });

  it('ratioText names both colours, so a failure message is actionable', () => {
    expect(ratioText('#000000', '#242424')).toBe('1.35:1 (#000000 on #242424)');
  });
});
