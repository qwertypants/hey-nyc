/**
 * INTEGRATION NOTES (src/map/style.ts)
 *
 * THE dining-type vocabulary. One place, imported by `layers.ts` (paint), by the legend
 * and by the detail sheet (wording). Nothing else in the app is allowed to invent a type
 * colour, a type shape or a type label.
 *
 * Public surface:
 *   type TypeShape
 *   type TypeStyle
 *   DINING_TYPE_STYLES, DINING_TYPE_STYLE_LIST
 *   CLUSTER_STYLE, SELECTED_STYLE, LABEL_STYLE
 *   describeType(type: DiningType): string
 *   typeShortLabel(type: DiningType): string
 *   typeStyle(type: DiningType): TypeStyle
 *   shapeDescription(shape: TypeShape): string
 *
 * This module imports no MapLibre, no React and no data, so a unit test or a Stream C
 * component can import the tokens without pulling the map engine into jsdom.
 *
 * WHY THREE CHANNELS, NOT ONE — dining type must never be encoded by colour alone:
 *   1. SHAPE  sidewalk = small solid disc; roadway = large disc with a heavy dark rim;
 *            both = an annulus (a ring around a disc) drawn as a halo plus a disc.
 *   2. SIZE   the three shapes are deliberately different sizes at every zoom.
 *   3. TEXT   from z15.5 up, a labelled layer prints the type word next to the name, and
 *            the accessible name of every point in the legend is the full phrase.
 * Colour is the fourth, redundant channel.
 */

import type { DiningType } from '../types/location';

export type TypeShape = 'disc' | 'rimmed-disc' | 'ring';

export interface TypeStyle {
  readonly type: DiningType;
  /** Screen-reader / detail-sheet wording. The only place this string is written down. */
  readonly label: string;
  /** Compact form for the high-zoom map label: "Sidewalk", "Roadway", "Both". */
  readonly shortLabel: string;
  /** Dominant fill colour. */
  readonly color: string;
  /** Rim / outer-ring colour, also used for the text halo. */
  readonly outlineColor: string;
  /** Disc radius in pixels at the base zoom. */
  readonly radius: number;
  /** Rim width in pixels (0 for a plain disc). */
  readonly strokeWidth: number;
  /** Which of the three shapes this type uses. */
  readonly shape: TypeShape;
  /** How the shape is described in the legend's text, for users who cannot see it. */
  readonly shapeDescription: string;
}

const SIDEWALK: TypeStyle = {
  type: 'sidewalk',
  label: 'Sidewalk dining',
  shortLabel: 'Sidewalk',
  color: '#1d4ed8',
  outlineColor: '#0b2a6b',
  radius: 5,
  strokeWidth: 0,
  shape: 'disc',
  shapeDescription: 'Small solid circle',
};

const ROADWAY: TypeStyle = {
  type: 'roadway',
  label: 'Roadway dining',
  shortLabel: 'Roadway',
  color: '#b45309',
  outlineColor: '#1b1b1f',
  radius: 7,
  strokeWidth: 2.5,
  shape: 'rimmed-disc',
  shapeDescription: 'Large circle with a heavy dark rim',
};

const BOTH: TypeStyle = {
  type: 'both',
  label: 'Sidewalk + roadway dining',
  shortLabel: 'Both',
  color: '#6d28d9',
  outlineColor: '#f5f3ff',
  radius: 5,
  strokeWidth: 0,
  shape: 'ring',
  shapeDescription: 'Circle with a ring around it',
};

export const DINING_TYPE_STYLES: Readonly<Record<DiningType, TypeStyle>> = {
  sidewalk: SIDEWALK,
  roadway: ROADWAY,
  both: BOTH,
};

/** Canonical display order: sidewalk, roadway, both. */
export const DINING_TYPE_STYLE_LIST: readonly TypeStyle[] = [SIDEWALK, ROADWAY, BOTH];

export function typeStyle(type: DiningType): TypeStyle {
  return DINING_TYPE_STYLES[type];
}

/** `"Sidewalk + roadway dining"` — screen readers and the detail sheet get real text. */
export function describeType(type: DiningType): string {
  return DINING_TYPE_STYLES[type].label;
}

export function typeShortLabel(type: DiningType): string {
  return DINING_TYPE_STYLES[type].shortLabel;
}

export function shapeDescription(shape: TypeShape): string {
  switch (shape) {
    case 'disc':
      return 'Small solid circle';
    case 'rimmed-disc':
      return 'Large circle with a heavy dark rim';
    case 'ring':
      return 'Circle with a ring around it';
  }
}

/** Cluster bubbles. Deliberately neutral so they never read as a dining type. */
export const CLUSTER_STYLE = {
  color: '#1f2937',
  opacity: 0.85,
  strokeColor: '#ffffff',
  strokeWidth: 1.5,
  textColor: '#ffffff',
  /** point_count -> radius, before the interpolation stops. */
  minRadius: 14,
  maxRadius: 30,
} as const;

/** The single selected point: a bright ring plus a scale bump so it is unmistakable. */
export const SELECTED_STYLE = {
  radius: 13,
  color: '#ffffff',
  ringColor: '#111827',
  ringWidth: 4,
  /** Circles get a minimum apparent size so a lone selection is visible at z16. */
  minRadiusPixels: 22,
} as const;

/** High-zoom text labels. Exists so type and name are never colour-only information. */
export const LABEL_STYLE = {
  minZoom: 15.5,
  /**
   * The exact fontstack the `positron` style requests, so labels resolve against the same
   * glyph endpoint the basemap already uses. A fontstack the basemap does not serve
   * renders nothing, which would silently remove the non-colour channel.
   */
  fontStack: ['Noto Sans Regular'],
  textSize: 11,
  textColor: '#111827',
  haloColor: '#ffffff',
  haloWidth: 1.4,
  /** In ems, with `textLineHeight: 1`, so MapLibre ellipsises rather than overlapping. */
  maxWidthEm: 12,
} as const;
