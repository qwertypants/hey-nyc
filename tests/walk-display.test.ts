/**
 * THE DISPLAY CHOKE POINT'S TEST SUITE.
 *
 * `src/features/walk/display.ts` exists for one reason, and this file is that reason written
 * as assertions. If every one of these tests were deleted and the module were replaced with
 * `sensor.activity`, the app would still work and every number would still be the source's —
 * and it would be calling an empty 01:15 bucket "quiet" and printing a bare `percentile: 50`
 * next to it, which is the claim this suite refuses.
 *
 * It also pins the visual vocabulary: the tables are total over the contract's enums, the
 * channels are distinct from each other, and every fill clears WCAG 1.4.11 on the two
 * light-scheme surfaces the legend and the chart are actually drawn on. The contrast maths is
 * `src/lib/contrast.ts`, not a hand-rolled luminance — the whole point of that module is that
 * "is this dark enough to read" is a question with an answer.
 */

import { describe, expect, it } from 'vitest';
import { ACTIVITY_LEVELS, SENSOR_ACTIVITIES, STALENESS_STATES, TREND_STATES } from '../src/types/walk';
import type { SensorProperties } from '../src/types/walk';
import { displayActivity, displaySensor, hasReading, isZeroBucket } from '../src/features/walk/display';
import {
  ACTIVITY_STYLES,
  CHART_STYLE,
  SENSOR_STYLE,
  STALENESS_STYLES,
  TREND_STYLES,
} from '../src/features/walk/style';
import { AA_NON_TEXT, AA_TEXT, contrastRatio, ratioText } from '../src/lib/contrast';
import {
  NOW_MS,
  SENSOR_BUSY,
  SENSOR_COLLECTION,
  SENSOR_NO_HISTORY,
  SENSOR_OFFLINE,
  SENSOR_STALE_ZERO_BUCKET,
} from './helpers/walkFixtures';

/** The two light-scheme surfaces the legend, the list rows and the chart are painted on. */
const SURFACES = ['#ffffff', '#f7f7f7'] as const;

function sensorById(id: string): SensorProperties {
  const found = SENSOR_COLLECTION.features.find((feature) => feature.properties.id === id);
  if (found === undefined) throw new Error(`no sensor fixture with id ${id}`);
  return found.properties;
}

describe('an empty bucket is never an activity level', () => {
  it('the published 0-in-a-0-bucket collapses to unavailable, not to quiet', () => {
    // THE case. `activity: "quiet"` is what the source says, because the counter measured
    // nobody at 01:15 and the same slot is usually nobody. What the reader is entitled to is
    // told to them, and it is not that the street was quiet.
    const sensor = sensorById(SENSOR_STALE_ZERO_BUCKET.id);
    expect(sensor.activity).toBe('quiet');
    expect(isZeroBucket(sensor)).toBe(true);
    expect(hasReading(sensor)).toBe(true);
    expect(displayActivity(sensor)).toBe('unavailable');
  });

  it('a level IS shown when there is a real count and a real expectation', () => {
    // The other direction, so the guard cannot pass by refusing to show a level ever.
    expect(displayActivity(sensorById(SENSOR_BUSY.id))).toBe('busy');
    expect(displayActivity(sensorById(SENSOR_BUSY.id))).not.toBe('unavailable');
  });

  it('a zero count against a NON-zero expectation is left alone — that is a quiet street', () => {
    const sensor: SensorProperties = {
      ...sensorById(SENSOR_BUSY.id),
      count: 0,
      expected: 12,
      activity: 'quiet',
    };
    expect(isZeroBucket(sensor)).toBe(false);
    expect(displayActivity(sensor)).toBe('quiet');
  });

  it('a null count is unavailable however the source labelled it', () => {
    const sensor: SensorProperties = { ...sensorById(SENSOR_BUSY.id), count: null };
    expect(displayActivity(sensor)).toBe('unavailable');
  });

  it('a null observedAt is unavailable even with a count', () => {
    const sensor: SensorProperties = { ...sensorById(SENSOR_BUSY.id), observedAt: null };
    expect(displayActivity(sensor)).toBe('unavailable');
  });

  it('the four published shapes all collapse or hold correctly', () => {
    expect(displayActivity(sensorById(SENSOR_STALE_ZERO_BUCKET.id))).toBe('unavailable');
    expect(displayActivity(sensorById(SENSOR_BUSY.id))).toBe('busy');
    expect(displayActivity(sensorById(SENSOR_OFFLINE.id))).toBe('unavailable');
    expect(displayActivity(sensorById(SENSOR_NO_HISTORY.id))).toBe('unavailable');
  });
});

describe('the percentile is withheld whenever it is arithmetic on an empty set', () => {
  it('a median of an empty distribution is not printed', () => {
    const display = displaySensor(sensorById(SENSOR_STALE_ZERO_BUCKET.id), null);
    expect(display.sensor.percentile).toBe(50);
    expect(display.percentile).toBeNull();
    expect(display.hasLevel).toBe(false);
  });

  it('a real percentile survives when there is an expectation to be a position within', () => {
    const display = displaySensor(sensorById(SENSOR_BUSY.id), null);
    expect(display.percentile).toBe(93);
    expect(display.hasLevel).toBe(true);
  });

  it('a zero expectation withholds it even when the count is non-zero', () => {
    const sensor: SensorProperties = {
      ...sensorById(SENSOR_BUSY.id),
      expected: 0,
      ratio: null,
    };
    const display = displaySensor(sensor, null);
    expect(display.sensor.percentile).toBe(93);
    expect(display.percentile).toBeNull();
  });

  it('the empty-bucket flag is set only for a bucket that was measured and found empty', () => {
    expect(displaySensor(sensorById(SENSOR_STALE_ZERO_BUCKET.id), null).emptyBucket).toBe(true);
    expect(displaySensor(sensorById(SENSOR_OFFLINE.id), null).emptyBucket).toBe(false);
    expect(displaySensor(sensorById(SENSOR_BUSY.id), null).emptyBucket).toBe(false);
  });
});

describe('the vocabulary is total over the frozen contract, and `unavailable` is not a level', () => {
  it('every trend has a style', () => {
    for (const trend of TREND_STATES) expect(TREND_STYLES[trend]).toBeDefined();
  });

  it('every activity has a style, and every staleness has a style', () => {
    for (const activity of SENSOR_ACTIVITIES) expect(ACTIVITY_STYLES[activity]).toBeDefined();
    for (const staleness of STALENESS_STATES) expect(STALENESS_STYLES[staleness]).toBeDefined();
  });

  it('`unavailable` is styled as a state, and every level is styled as a level', () => {
    expect(ACTIVITY_STYLES.unavailable.isLevel).toBe(false);
    for (const level of ACTIVITY_LEVELS) expect(ACTIVITY_STYLES[level].isLevel).toBe(true);
  });

  it('`unavailable` has a colour of its own, so it cannot be mistaken for `quiet`', () => {
    // If these two were ever the same hex, a missing measurement and a genuinely empty street
    // would be the same mark — which is the whole failure this module exists to prevent.
    expect(ACTIVITY_STYLES.unavailable.color).not.toBe(ACTIVITY_STYLES.quiet.color);
  });

  it('every activity colour is distinct, so the palette cannot collapse two states into one', () => {
    const colors = SENSOR_ACTIVITIES.map((activity) => ACTIVITY_STYLES[activity].color);
    expect(new Set(colors).size).toBe(colors.length);
  });

  it('every trend colour is distinct', () => {
    const colors = TREND_STATES.map((trend) => TREND_STYLES[trend].color);
    expect(new Set(colors).size).toBe(colors.length);
  });

  it('no two trends share a silhouette, so the shape channel carries the trend alone', () => {
    const shapes = TREND_STATES.map((trend) => TREND_STYLES[trend].shape);
    expect(new Set(shapes).size).toBe(shapes.length);
  });

  it('trend is separated by RIM WEIGHT, not only by colour', () => {
    // The channel that survives greyscale. `flat` has no rim at all and `rising` has the
    // heaviest one, which is a 3.5px difference visible in a black-and-white screenshot.
    expect(TREND_STYLES.flat.strokeWidth).toBe(0);
    expect(TREND_STYLES.rising.strokeWidth).toBeGreaterThan(TREND_STYLES.falling.strokeWidth);
    expect(TREND_STYLES.falling.strokeWidth).toBeGreaterThan(TREND_STYLES.flat.strokeWidth);
  });

  it('staleness is separated by fill opacity and by the centre mark, not only by colour', () => {
    expect(STALENESS_STYLES.fresh.coreOpacity).toBe(1);
    expect(STALENESS_STYLES.stale.coreOpacity).toBeGreaterThan(0);
    expect(STALENESS_STYLES.stale.coreOpacity).toBeLessThan(1);
    expect(STALENESS_STYLES.offline.coreOpacity).toBe(0);
    expect(STALENESS_STYLES.fresh.glyph).toBe('+');
    expect(STALENESS_STYLES.stale.glyph).toBe('+');
    expect(STALENESS_STYLES.offline.glyph).toBe('x');
    expect(STALENESS_STYLES.unavailable.glyph).toBe('x');
  });

  it('a dead counter gets a second ring, because four points can share a neighbourhood', () => {
    expect(STALENESS_STYLES.offline.doubleRing).toBe(true);
    expect(STALENESS_STYLES.unavailable.doubleRing).toBe(true);
    expect(STALENESS_STYLES.fresh.doubleRing).toBe(false);
    expect(SENSOR_STYLE.doubleRingRadius).toBeGreaterThan(SENSOR_STYLE.ringRadius);
  });

  it('the centre marks are ASCII, so they cannot fail to render against the basemap font', () => {
    // A glyph outside the `Noto Sans` stack renders as nothing, which would remove the
    // non-colour channel silently — the worst direction for this to fail in.
    for (const staleness of STALENESS_STATES) {
      expect(STALENESS_STYLES[staleness].glyph).toMatch(/^[+x]$/);
    }
  });

  it('the sensor geometry is a ring, and the core is inside it — never a solid disc', () => {
    expect(SENSOR_STYLE.ringRadius).toBeGreaterThan(SENSOR_STYLE.coreRadius);
    expect(SENSOR_STYLE.ringHaloColor).toBe('#ffffff');
  });
});

describe('every data colour clears WCAG 2.2 AA non-text contrast on both light surfaces', () => {
  /**
   * 1.4.11 asks 3:1 of "meaningful graphics". The bars and swatches ARE the information here,
   * so there is no exemption to lean on for the fill itself — only for the dark scheme, where
   * the same reasoning as `--eoy-type-*` applies: the fill has to be the colour the map is
   * painting, and the word is always printed beside it.
   */
  for (const color of [...TREND_STATES.map((t) => TREND_STYLES[t].color), ...SENSOR_ACTIVITIES.map((a) => ACTIVITY_STYLES[a].color)]) {
    it(`${color} clears ${AA_NON_TEXT}:1`, () => {
      for (const surface of SURFACES) {
        const ratio = contrastRatio(color, surface);
        expect(
          ratio,
          `${color} on ${surface} is ${ratioText(color, surface)}, below the ${AA_NON_TEXT}:1 floor`,
        ).toBeGreaterThanOrEqual(AA_NON_TEXT);
      }
    });
  }

  it('the chart bars clear 3:1 against the card they are drawn on', () => {
    for (const surface of SURFACES) {
      const ratio = contrastRatio(CHART_STYLE.barFill, surface);
      expect(ratio, `${CHART_STYLE.barFill} on ${surface} is ${ratioText(CHART_STYLE.barFill, surface)}`).toBeGreaterThanOrEqual(
        AA_NON_TEXT,
      );
    }
  });

  it('the most recent bar is black, so it is distinguishable from the older ones in greyscale', () => {
    expect(contrastRatio(CHART_STYLE.latestBarFill, '#ffffff')).toBeGreaterThanOrEqual(AA_TEXT);
    expect(CHART_STYLE.latestBarFill).not.toBe(CHART_STYLE.barFill);
  });

  it('the counter ring and the axis clear 3:1 too', () => {
    for (const surface of SURFACES) {
      expect(contrastRatio(SENSOR_STYLE.ringColor, surface)).toBeGreaterThanOrEqual(AA_NON_TEXT);
      expect(contrastRatio(CHART_STYLE.axisColor, surface)).toBeGreaterThanOrEqual(AA_NON_TEXT);
    }
  });
});

describe('the clock is a parameter, not an ambient fact', () => {
  it('the fixture clock is the one the staleness sentences are written against', () => {
    // If this ever drifts, "14 hours ago" in the detail sheet is no longer what the tests say
    // it is, and every wording assertion below becomes a coincidence.
    expect(NOW_MS - Date.parse('2026-09-28T01:30:00Z')).toBe(14 * 60 * 60 * 1000);
  });
});
