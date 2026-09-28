/**
 * INTEGRATION NOTES (src/features/walk/style.ts)
 *
 * THE WALK VOCABULARY. The single place a trend colour, an activity colour, a staleness shape
 * or a chart colour is written down, exactly as `src/map/style.ts` is for dining type. The
 * layers read their paint from here, the legend reads its swatches from here, the detail
 * sheet reads its words from here, and the chart reads its marks from here. Nothing else in
 * the feature is allowed to invent one.
 *
 * Imports no MapLibre, no React and no data, so a unit test can read the tokens without
 * pulling the map engine into jsdom — the same reason `src/map/style.ts` is shaped this way.
 *
 * WHY FOUR CHANNELS, NOT ONE — nothing here is colour-only:
 *   Historical survey sites (a DISC):
 *     1. SHAPE + RIM  rising = a heavy ring around a small core; falling = a wide solid disc
 *                      with a thin rim; flat = a plain solid disc with no rim; insufficient =
 *                      a small disc at low opacity. Four distinguishable silhouettes, and the
 *                      rim weight is the part that survives greyscale and colour blindness.
 *     2. SIZE         the survey's `total`, so a busy site is a bigger mark for a second,
 *                      independent reason.
 *     3. TEXT         from z15.5 the trend word is printed beside the site name, which is
 *                      the channel that survives everything.
 *     4. COLOUR       the redundant fourth.
 *   Automated counters (a RING around a core, with a mark at the centre):
 *     1. SHAPE         a ring, not a disc — the two datasets must never be confused for each
 *                      other at a glance, and there are only four counters against 114
 *                      sites, so the shape difference costs nothing and settles everything.
 *     2. CORE FILL     fresh = solid, stale = washed out, offline / unavailable = hollow.
 *                      Four fills that differ in more than hue.
 *     3. CENTRE MARK   a `+` for a counter that is reporting, an `x` for one that is not.
 *                      ASCII on purpose: it is in the `Noto Sans Regular` stack the
 *                      basemap already serves, so it cannot fail to render, and a missing
 *                      glyph would remove the non-colour channel silently.
 *     4. COLOUR        the activity, with `unavailable` given its OWN colour that is not the
 *                      `quiet` colour. See `src/features/walk/display.ts` for why that
 *                      collapse is the important part of this file's contract.
 *
 * WHY THE FILLS ARE NOT OVERRIDDEN IN THE DARK SCHEME. The same reason, and the same
 * reasoning, as `--eoy-type-*` in `src/index.css`: the swatch has to be the colour the map
 * is painting, and a legend that disagrees with the map is a worse failure than a dim swatch.
 * WCAG 1.4.11 exempts a graphic whose information is also available in text, and here the
 * word is always printed beside the swatch, in the legend, in the list row and in the detail
 * sheet. What IS scheme-aware is the swatch EDGE, which uses `--eoy-swatch-edge` and so
 * flips with the theme. Every fill below clears 3:1 on the light scheme's two surfaces, and
 * `tests/walk-style.test.ts` measures that with `src/lib/contrast.ts` rather than trusting it.
 *
 * Public surface:
 *   type TrendShape, type StalenessMark, type TrendStyle, type ActivityStyle, type StalenessStyle
 *   TREND_STYLES, TREND_STYLE_LIST, ACTIVITY_STYLES, ACTIVITY_STYLE_LIST
 *   STALENESS_STYLES, STALENESS_STYLE_LIST
 *   trendStyle, activityStyle, stalenessStyle
 *   CHART_STYLE, SENSOR_STYLE
 *   describeTrendShape, describeStalenessShape
 */

import { ACTIVITY_LEVELS, SENSOR_ACTIVITIES, STALENESS_STATES, TREND_STATES } from '../../types/walk';
import type { SensorActivity, Staleness, Trend } from '../../types/walk';

/** The outline every data mark carries, on every basemap. Mirrors the eat layers' rim. */
const MARK_OUTLINE = '#111827';

export type TrendShape = 'ringed-core' | 'wide-disc' | 'plain-disc' | 'faint-disc';

export interface TrendStyle {
  readonly trend: Trend;
  /** The word. The legend, the list badge, the map label and the detail sheet all use it. */
  readonly label: string;
  /** What the direction means, in a clause, for the detail sheet. */
  readonly words: string;
  readonly color: string;
  readonly outlineColor: string;
  /** The rim channel. 0 is a plain disc; 3.5 is a ring you can read at a glance. */
  readonly strokeWidth: number;
  /** Radius of the CORE, in pixels. Size also carries the survey's `total`, so this is the floor. */
  readonly radius: number;
  /** Opacity. Only `insufficient` is ever reduced — it is the state that has no measurement. */
  readonly opacity: number;
  readonly shape: TrendShape;
  /** How the silhouette is described for a reader who cannot see it. */
  readonly shapeDescription: string;
}

const RISING: TrendStyle = {
  trend: 'rising',
  label: 'Rising',
  words: 'counted more people than in its first survey',
  color: '#0f766e',
  outlineColor: MARK_OUTLINE,
  strokeWidth: 3.5,
  radius: 4.5,
  opacity: 1,
  shape: 'ringed-core',
  shapeDescription: 'Small core inside a heavy ring',
};

const FALLING: TrendStyle = {
  trend: 'falling',
  label: 'Falling',
  words: 'counted fewer people than in its first survey',
  color: '#b45309',
  outlineColor: MARK_OUTLINE,
  strokeWidth: 1.5,
  radius: 6,
  opacity: 1,
  shape: 'wide-disc',
  shapeDescription: 'Wide solid circle with a thin rim',
};

const FLAT: TrendStyle = {
  trend: 'flat',
  label: 'Flat',
  words: 'counted within 15% of its first survey, which is the band the source calls flat',
  color: '#4a5568',
  outlineColor: MARK_OUTLINE,
  strokeWidth: 0,
  radius: 5.5,
  opacity: 1,
  shape: 'plain-disc',
  shapeDescription: 'Plain solid circle, no rim',
};

const INSUFFICIENT: TrendStyle = {
  trend: 'insufficient',
  label: 'Not enough surveys',
  words: 'has too few surveys, or too short a span, for the source to call a direction',
  color: '#6b7280',
  outlineColor: MARK_OUTLINE,
  strokeWidth: 0,
  radius: 3.5,
  opacity: 0.45,
  shape: 'faint-disc',
  shapeDescription: 'Small faint circle',
};

const TRENDS: readonly TrendStyle[] = [RISING, FALLING, FLAT, INSUFFICIENT];

export const TREND_STYLES: Readonly<Record<Trend, TrendStyle>> = {
  rising: RISING,
  falling: FALLING,
  flat: FLAT,
  insufficient: INSUFFICIENT,
};

export const TREND_STYLE_LIST: readonly TrendStyle[] = TRENDS;

export interface ActivityStyle {
  readonly activity: SensorActivity;
  /**
   * The word. For `unavailable` this is NOT a level word and the string says so — it is the
   * only place in the feature where that sentence is written, and the chart of activity is
   * five entries wide with a hole in it rather than four.
   */
  readonly label: string;
  /** The same for the layer label and the list badge. */
  readonly shortLabel: string;
  readonly color: string;
  /**
   * `unavailable` is a state, so it gets its own grey. It must not be the `quiet` colour,
   * or a missing measurement and a genuinely empty street would be the same mark.
   */
  readonly isLevel: boolean;
  readonly shapeDescription: string;
}

const NO_READING: ActivityStyle = {
  activity: 'unavailable',
  label: 'No recent reading',
  shortLabel: 'No reading',
  color: '#374151',
  isLevel: false,
  shapeDescription: 'Hollow ring with an x — no measurement, not a level',
};

const QUIET: ActivityStyle = {
  activity: 'quiet',
  label: 'Quiet',
  shortLabel: 'Quiet',
  color: '#0e7490',
  isLevel: true,
  shapeDescription: 'Solid core with a +',
};

const TYPICAL: ActivityStyle = {
  activity: 'typical',
  label: 'Typical',
  shortLabel: 'Typical',
  color: '#4d7c0f',
  isLevel: true,
  shapeDescription: 'Solid core with a +',
};

const BUSY: ActivityStyle = {
  activity: 'busy',
  label: 'Busy',
  shortLabel: 'Busy',
  color: '#a16207',
  isLevel: true,
  shapeDescription: 'Solid core with a +',
};

const VERY_BUSY: ActivityStyle = {
  activity: 'veryBusy',
  label: 'Very busy',
  shortLabel: 'Very busy',
  color: '#b91c1c',
  isLevel: true,
  shapeDescription: 'Solid core with a +',
};

const ACTIVITIES: readonly ActivityStyle[] = [NO_READING, QUIET, TYPICAL, BUSY, VERY_BUSY];

export const ACTIVITY_STYLES: Readonly<Record<SensorActivity, ActivityStyle>> = {
  unavailable: NO_READING,
  quiet: QUIET,
  typical: TYPICAL,
  busy: BUSY,
  veryBusy: VERY_BUSY,
};

export const ACTIVITY_STYLE_LIST: readonly ActivityStyle[] = ACTIVITIES;

export type StalenessMark = 'plus' | 'cross' | 'none';

export interface StalenessStyle {
  readonly staleness: Staleness;
  readonly label: string;
  /** The word for the list badge and the legend. */
  readonly shortLabel: string;
  /** The centre mark's NAME. A glyph rather than a colour, so freshness survives greyscale. */
  readonly mark: StalenessMark;
  /**
   * The character the map prints, and the character a legend draws. ASCII on purpose: a glyph
   * outside the `Noto Sans` stack the basemap serves renders as NOTHING, which would remove
   * the non-colour channel silently — the worst direction for this to fail in. Asserted at
   * module load below.
   */
  readonly glyph: '+' | 'x';
  /** How opaque the core is. 0 is a hollow ring: nothing was measured there. */
  readonly coreOpacity: number;
  /** Outer ring weight, so a long-dead counter is visibly heavier than a late one. */
  readonly ringWidth: number;
  /** A second, outer ring. Only a counter that has been dead for a while gets one. */
  readonly doubleRing: boolean;
  readonly shapeDescription: string;
}

const FRESH: StalenessStyle = {
  staleness: 'fresh',
  label: 'Reporting',
  shortLabel: 'Fresh',
  mark: 'plus',
  glyph: '+',
  coreOpacity: 1,
  ringWidth: 2.5,
  doubleRing: false,
  shapeDescription: 'Ring with a solid core and a +',
};

const STALE: StalenessStyle = {
  staleness: 'stale',
  label: 'Late',
  shortLabel: 'Late',
  mark: 'plus',
  glyph: '+',
  coreOpacity: 0.3,
  ringWidth: 2.5,
  doubleRing: false,
  shapeDescription: 'Ring with a washed-out core and a +',
};

const OFFLINE: StalenessStyle = {
  staleness: 'offline',
  label: 'Offline',
  shortLabel: 'Offline',
  mark: 'cross',
  glyph: 'x',
  coreOpacity: 0,
  ringWidth: 3,
  doubleRing: true,
  shapeDescription: 'Two concentric rings around an empty middle, with an x',
};

const UNREAD: StalenessStyle = {
  staleness: 'unavailable',
  label: 'No reading',
  shortLabel: 'No reading',
  mark: 'cross',
  glyph: 'x',
  coreOpacity: 0,
  ringWidth: 3,
  doubleRing: true,
  shapeDescription: 'Two concentric rings around an empty middle, with an x',
};

const STALENESS: readonly StalenessStyle[] = [FRESH, STALE, OFFLINE, UNREAD];

export const STALENESS_STYLES: Readonly<Record<Staleness, StalenessStyle>> = {
  fresh: FRESH,
  stale: STALE,
  offline: OFFLINE,
  unavailable: UNREAD,
};

export const STALENESS_STYLE_LIST: readonly StalenessStyle[] = STALENESS;

export function trendStyle(trend: Trend): TrendStyle {
  return TREND_STYLES[trend];
}

export function activityStyle(activity: SensorActivity): ActivityStyle {
  return ACTIVITY_STYLES[activity];
}

export function stalenessStyle(staleness: Staleness): StalenessStyle {
  return STALENESS_STYLES[staleness];
}

export function describeTrendShape(trend: Trend): string {
  return TREND_STYLES[trend].shapeDescription;
}

export function describeStalenessShape(staleness: Staleness): string {
  return STALENESS_STYLES[staleness].shapeDescription;
}

/**
 * The counter geometry, in one place because the RING is what separates the automated
 * program from the manual one. 114 discs and 4 rings on one map is a distinction a reader
 * makes before they read a word.
 */
export const SENSOR_STYLE = {
  ringRadius: 11,
  doubleRingRadius: 15,
  coreRadius: 5,
  ringColor: MARK_OUTLINE,
  ringHaloColor: '#ffffff',
  /** 4 points can share a neighbourhood, so the mark is a fixed size regardless of `count`. */
  markSize: 12,
  markColor: MARK_OUTLINE,
  markFont: ['Noto Sans Bold'],
} as const;

/**
 * The survey chart. Monochrome on purpose, for the same reason the chrome is: the bars
 * encode a NUMBER (a survey total), and a colour on them would imply they encode a category.
 * The one colour that varies is the most recent survey, which is in full ink while the rest
 * are in the muted rule colour — so "which one is now" survives greyscale.
 */
export const CHART_STYLE = {
  barFill: '#767676',
  latestBarFill: '#000000',
  axisColor: '#767676',
  labelColor: '#000000',
  height: 168,
  paddingTop: 8,
  paddingBottom: 26,
  paddingStart: 4,
  paddingEnd: 4,
  /** Bars never get thinner than this, so the last survey is always a visible mark. */
  minBarWidth: 2,
  gap: 1,
  labelSize: 10,
} as const;

/**
 * The vocabulary must stay total over the contract's enums. A new `trend` or `activity` the
 * pipeline publishes has to be a compile error here rather than an uncoloured mark on the
 * map, so the enums are asserted against the tables at module load.
 */
const TREND_KEYS: readonly Trend[] = TREND_STATES;
const ACTIVITY_KEYS: readonly SensorActivity[] = SENSOR_ACTIVITIES;
const LEVEL_KEYS: readonly SensorActivity[] = ACTIVITY_LEVELS;
const STALENESS_KEYS: readonly Staleness[] = STALENESS_STATES;

function requireComplete(what: string, keys: readonly string[], table: Readonly<Record<string, unknown>>): void {
  const missing = keys.filter((key) => table[key] === undefined);
  if (missing.length > 0) {
    throw new Error(`src/features/walk/style.ts has no entry for ${what}: ${missing.join(', ')}`);
  }
}

requireComplete('trend', TREND_KEYS, TREND_STYLES);
requireComplete('activity', ACTIVITY_KEYS, ACTIVITY_STYLES);
requireComplete('staleness', STALENESS_KEYS, STALENESS_STYLES);

// The centre glyphs must be ASCII, or a basemap that does not serve them removes the only
// channel that is not colour. Checked here rather than in a test, because a violation would
// ship a map that renders a blank where the `+` and the `x` should be.
for (const style of STALENESS_STYLE_LIST) {
  if (!/^[\x20-\x7e]$/.test(style.glyph)) {
    throw new Error(`staleness glyph for "${style.staleness}" is not printable ASCII: ${style.glyph}`);
  }
}

// Every level, and only a level, may claim to be one. `unavailable` is the exclusion, and it
// is asserted rather than assumed — the whole feature leans on it.
if (ACTIVITY_STYLES.unavailable.isLevel) {
  throw new Error('unavailable is a state, not an activity level, and must not be styled as one');
}
for (const level of LEVEL_KEYS) {
  if (!ACTIVITY_STYLES[level].isLevel) {
    throw new Error(`activity level "${level}" must be styled as a level`);
  }
}
