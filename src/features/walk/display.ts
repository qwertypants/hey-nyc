/**
 * INTEGRATION NOTES (src/features/walk/display.ts)
 *
 * THE CHOKE POINT. Everything the UI is allowed to say about an automated counter passes
 * through `displayActivity` on its way to a colour, a legend swatch, a list badge or a
 * sentence. There is no second path, which is the whole point: a rule that lives in one
 * function cannot be forgotten in a component.
 *
 * WHAT IT REFUSES, AND WHY
 * ------------------------
 * `unavailable` is already a state and not a level — the contract says so and the reason is
 * good. But the current artifact contains a second, subtler version of the same mistake,
 * and a UI that only checked for `unavailable` would publish it:
 *
 *     Concrete Plant Park  count 0  expected 0  percentile 50  activity "quiet"
 *
 * The newest 15-minute bucket lands at 01:15. The counter measured nobody, and the same slot
 * on the same weekday is usually nobody either, so the counter sits at the median of an empty
 * distribution. "Quiet" is a claim about a street; what the data says is that the hour is
 * empty. Painting that as the first of four activity levels — or showing a bare
 * `percentile: 50` next to it — is a number wearing a label it did not earn.
 *
 * So a sensor is treated as having NO READING whenever its latest bucket is empty: the
 * published `activity` is `unavailable`, or there is no observation, or the reading and its
 * expectation are both zero. In every one of those cases the display activity collapses to
 * `unavailable`, the neutral colour, and the words "No recent reading". A level is only
 * claimed when a real count was compared against a real expectation and the pipeline
 * concluded one.
 *
 * 61% of all pedestrian observations in the automated feed are exactly 0, and 60.6% of the
 * baseline keys have a median of exactly 0. A zero-dominated bucket is the MAJORITY case, so
 * this is not a rare guard dressed up as a principle — it is the normal path through this
 * file, and the feature is built around it rather than around the exception.
 *
 * WHAT IT DELIBERATELY DOES NOT DO. It does not hide a counter. `staleness`, the age of the
 * reading and the counter's name are all still shown; what is withheld is a claim about how
 * busy the place is. "We have a counter here and its last reading is missing" and "this is a
 * quiet street" are different sentences, and only the first one is supported.
 *
 * Public surface:
 *   isZeroBucket(sensor): boolean
 *   hasReading(sensor): boolean
 *   displayActivity(sensor): SensorActivity
 *   displaySensor(sensor, latest): DisplaySensor
 */

import type { SensorActivity, SensorProperties, Staleness } from '../../types/walk';
import type { WalkLatestSensor } from '../../data/walk/validate';

/**
 * True when the newest 15-minute bucket is empty in the only way an empty bucket can be: the
 * counter reported nobody AND the same slot is usually nobody. One zero among non-zero
 * expectations is the ordinary evidence of a quiet street and is left alone.
 */
export function isZeroBucket(sensor: SensorProperties): boolean {
  return sensor.count === 0 && sensor.expected === 0;
}

/** A count and the timestamp it came from, which is what makes a reading a reading. */
export function hasReading(sensor: SensorProperties): boolean {
  return sensor.count !== null && sensor.observedAt !== null && sensor.activity !== 'unavailable';
}

/**
 * The activity the UI may present. `SensorActivity` rather than a narrower type, so the
 * colour table and the words table are both total over the contract's own vocabulary and a
 * new pipeline value fails to compile rather than rendering as something it is not.
 */
export function displayActivity(sensor: SensorProperties): SensorActivity {
  if (sensor.activity === 'unavailable') return 'unavailable';
  if (!hasReading(sensor)) return 'unavailable';
  if (isZeroBucket(sensor)) return 'unavailable';
  return sensor.activity;
}

/**
 * A counter and the wording that is permitted about it, resolved once.
 *
 * `latest` is the matching row from `latest.json` when it loaded, and null otherwise. It is
 * carried rather than looked up so the feature resolves it once per sensor, and so a missing
 * `latest.json` is a visible flag rather than a per-row special case.
 */
export interface DisplaySensor {
  readonly sensor: SensorProperties;
  readonly latest: WalkLatestSensor | null;
  /** Never a level when the reading is missing or the bucket is empty. */
  readonly activity: SensorActivity;
  /** Whether `activity` above is a real level, or the collapsed "no reading" state. */
  readonly hasLevel: boolean;
  /** Whether the newest bucket was empty rather than merely unmeasured. */
  readonly emptyBucket: boolean;
  /**
   * The percentile, or null when it would be a bare number with nothing behind it. Suppressed
   * for the same reason the level is: a median of an empty distribution is 50 by definition
   * and means nothing on its own.
   */
  readonly percentile: number | null;
  readonly staleness: Staleness;
}

export function displaySensor(
  sensor: SensorProperties,
  latest: WalkLatestSensor | null,
): DisplaySensor {
  const activity = displayActivity(sensor);
  const hasLevel = activity !== 'unavailable';
  const emptyBucket = hasLevel === false && isZeroBucket(sensor);

  return {
    sensor,
    latest,
    activity,
    hasLevel,
    emptyBucket,
    // A percentile needs an expectation to be a position within, and 61% of buckets have
    // none. `expected > 0` is the condition, not `percentile !== null`.
    percentile: hasLevel && sensor.expected !== null && sensor.expected > 0 ? sensor.percentile : null,
    staleness: sensor.staleness,
  };
}
