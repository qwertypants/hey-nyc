/**
 * INTEGRATION NOTES (src/features/walk/wording.ts)
 *
 * Every English sentence this feature speaks about a measurement, as a pure function of the
 * contract's values. One concern per function, no formatting decided at the call site, so the
 * list row, the detail sheet, the legend and the map label cannot drift apart — the same
 * reason `describeType` lives in `src/map/style.ts` rather than in `DetailSheet.tsx`.
 *
 * The rules these sentences obey, all of which exist because the source is thinner than the
 * question a visitor brings:
 *
 *   1. A DATE next to a count. "13,272 pedestrians" is a claim about a place; "13,272
 *      pedestrians, surveyed May 2026" is a claim about a day. The survey date is not
 *      metadata here, it is the sentence.
 *   2. `unavailable` is never "quiet". See `src/features/walk/display.ts` for the whole
 *      argument; here it is only the wording.
 *   3. Nothing between two surveys. Every trend sentence says what was compared and over
 *      what span, and never describes the gap.
 *   4. The automated feed is a daily batch, not a stream. It is never described as "now".
 *   5. No ranking language. "Busiest in the city" is a claim this source cannot support for
 *      114 screenlines; the detail sheet says what the survey counted and on what day.
 *
 * Locale is pinned to `en-US` throughout, so no output depends on the visitor's browser.
 *
 * Public surface:
 *   formatPedestrians, surveyHeadline, changeLine, yearsLine, pviLine, trendWords
 *   boroughLine, stalenessSentence, activityWord, countLine, expectedLine
 *   percentileLine, sensorCaveat, historicalCaveat, trendBadge, stalenessBadge
 *   surveySubtitle, sensorSubtitle
 */

import type { HistoricalProperties, Staleness, Trend } from '../../types/walk';
import { formatDateTimeUtc, formatDayAndMonth, relativeAge } from '../../data/walk/relativeTime';
import { activityStyle, stalenessStyle, trendStyle } from './style';
import type { DisplaySensor } from './display';

const NUMBER = new Intl.NumberFormat('en-US');

/** `13272` -> `"13,272"`. A null count is not a zero and never becomes one. */
export function formatPedestrians(count: number | null): string {
  return count === null ? 'Not measured' : NUMBER.format(count);
}

/** The headline for a survey site. The date is the point, so it leads. */
export function surveyHeadline(properties: HistoricalProperties): string {
  if (properties.latestSurvey === null) return 'Never surveyed';
  return `Surveyed ${properties.latestSurvey}`;
}

/** `"+3,666 since May 2007"` — the number, the direction and the span, together. */
export function changeLine(properties: HistoricalProperties): string {
  if (properties.change === null || properties.changeYears === null) {
    return 'No comparison — the source needs two complete surveys a minimum of five years apart';
  }
  const magnitude = NUMBER.format(Math.abs(properties.change));
  return `${properties.change >= 0 ? '+' : '−'}${magnitude} since ${properties.changeYears}`;
}

/** `"20 survey years, 2007 to 2026"`. How long the record behind the change is. */
export function yearsLine(properties: HistoricalProperties): string {
  const years = properties.yearsMeasured;
  const plural = years === 1 ? 'survey year' : 'survey years';
  if (properties.firstYear === null || properties.lastYear === null) {
    return `${years} ${plural}`;
  }
  return `${years} ${plural}, ${properties.firstYear} to ${properties.lastYear}`;
}

/** The Pedestrian Volume Index flag, only when it is set. `null` means omit the row. */
export function pviLine(properties: HistoricalProperties): string | null {
  if (!properties.inPedestrianVolumeIndex) return null;
  return 'Yes — this screenline is one of the sites in the city’s Pedestrian Volume Index';
}

/** What the trend means, as a clause that can follow the site name. */
export function trendWords(trend: Trend): string {
  return trendStyle(trend).words;
}

export function boroughLine(borough: string): string {
  return `${borough}, New York City`;
}

/**
 * THE SENSOR HEADLINE, and the staleness sentence in one place. The three cases are distinct
 * claims and are worded as three:
 *
 *   fresh / stale  "Last reading 14 hours ago"        there is a number, and how old it is
 *   offline        "Offline since 7 June 2026"        there is a number, and it stopped
 *   unavailable    "No recent reading"                 there is no number at all
 *
 * "Offline" is not a freshness adjective bolted onto a count; the count is gone, and the
 * sentence says so. A reader who sees "Offline since June 2026" and "Last reading 14 hours
 * ago" side by side can tell that one counter is a fortnight into silence and the other is
 * a day's batch behind — which is the difference the four published counters actually have.
 */
export function stalenessSentence(display: DisplaySensor, now: number): string {
  const { staleness, sensor } = display;
  const observed = display.latest?.observedAt ?? sensor.observedAt;
  const last = sensor.lastObservation ?? observed;

  if (staleness === 'offline') {
    if (last === null) return 'Offline, and no reading has ever been recorded';
    return `Offline since ${formatDayAndMonth(last) ?? 'an unknown date'}`;
  }
  if (staleness === 'unavailable') {
    return 'No recent reading';
  }
  return `Last reading ${relativeAge(observed, now)}`;
}

/** The activity word, or the honest absence of one. Never a level for a missing reading. */
export function activityWord(display: DisplaySensor): string {
  return activityStyle(display.activity).label;
}
/**
 * The count and its expected, side by side, and the whole zero-bucket argument in one line.
 *
 * "0 · usually 0 at this time on this weekday" is not a shrug. It is the sentence that stops
 * a reader concluding that a 1am measurement of an empty street means anything about how
 * busy the street is, and it is the reason `expected` is shown even when it is also zero.
 */
export function countLine(display: DisplaySensor): string {
  const { sensor } = display;
  if (sensor.count === null) return 'No recent reading';
  if (sensor.count === 0) return '0 people in the last 15-minute bucket';
  return `${NUMBER.format(sensor.count)} people in the last 15-minute bucket`;
}

export function expectedLine(display: DisplaySensor): string {
  const { sensor } = display;
  if (sensor.expected === null) return 'No expectation published';
  if (sensor.expected === 0) {
    return 'Usually 0 at this time on this weekday — this counter sits in empty hours';
  }
  return `Usually ${NUMBER.format(sensor.expected)} at this time on this weekday`;
}

/**
 * The percentile, or null. A percentile is a position within a distribution, so it needs a
 * distribution: with an expectation of zero the median of the baseline is zero and "50th
 * percentile" is arithmetic on an empty set. It is withheld rather than printed and
 * footnoted, because a bare number in a card is read as a measurement.
 *
 * The ORDINAL SUFFIX is not decoration. The first version of this line appended "th" to
 * every value and printed "93th percentile", which reads as a typo and undermines the number
 * it is qualifying. The three cases that matter in practice are 1st, 2nd, 3rd and everything
 * else, so those are handled and 11th/12th/13th are left with the default "th" rather than
 * being special-cased — a pipeline publishing a 12th-percentile bucket is not a case worth a
 * branch, and "12th" is what it should say.
 */
function ordinal(value: number): string {
  const whole = Math.round(value);
  const lastTwo = whole % 100;
  if (lastTwo >= 11 && lastTwo <= 13) return `${whole}th`;
  switch (whole % 10) {
    case 1:
      return `${whole}st`;
    case 2:
      return `${whole}nd`;
    case 3:
      return `${whole}rd`;
    default:
      return `${whole}th`;
  }
}

export function percentileLine(display: DisplaySensor): string | null {
  const percentile = display.percentile;
  if (percentile === null) return null;
  if (!display.hasLevel) return null;
  return `${ordinal(percentile)} percentile of this counter’s own history for this weekday and time`;
}

/** The honest sentence for a counter. Always present; never null. */
export function sensorCaveat(display: DisplaySensor): string {
  const { sensor } = display;
  const batch =
    'This feed is written by a daily batch, not a stream: 15-minute buckets are published up to the last complete day, so it is never a live "now".';

  if (display.emptyBucket) {
    return (
      'The newest bucket was empty and the same slot is usually empty, so this says nothing about how busy ' +
      'the street is. No activity level is shown, because a missing measurement is not a measurement of ' +
      'nothing. ' +
      batch
    );
  }
  if (!display.hasLevel) {
    const since =
      sensor.lastObservation === null
        ? 'This counter has no recorded observation at all.'
        : `Its last recorded observation is from ${formatDateTimeUtc(sensor.lastObservation) ?? 'an unknown time'} and it has been silent since.`;
    return (
      'No recent reading, so no activity is claimed here. ' +
      since +
      ' A missing measurement is not a measurement of nothing. ' +
      batch
    );
  }
  return (
    'Activity is relative to this counter’s own history for this weekday and time of day — not to other counters, ' +
    'and not to the rest of the city. ' +
    batch
  );
}

/** The honest sentence for a survey site. Always present; never null. */
export function historicalCaveat(properties: HistoricalProperties): string {
  if (properties.latestSurvey === null) {
    return 'This site has never been surveyed, so there is no count to show. It is on the map because DOT lists it as a screenline.';
  }
  return (
    `One manual screenline survey on ${properties.latestSurvey}, counted in three periods. ` +
    'DOT sends staff out two or three times a year; nothing between those surveys was measured, and this is not a live count.'
  );
}

/** The badge word for a list row, upper-cased by the caller. */
export function trendBadge(trend: Trend): string {
  return trendStyle(trend).label;
}

/** The badge word for a counter row: the staleness, never the activity. */
export function stalenessBadge(staleness: Staleness): string {
  return stalenessStyle(staleness).shortLabel;
}

/** The subtitle for a survey row: the date, then the count it belongs to. */
export function surveySubtitle(properties: HistoricalProperties): string {
  if (properties.latestSurvey === null) return 'Never surveyed';
  return `Surveyed ${properties.latestSurvey} · ${formatPedestrians(properties.total)} pedestrians`;
}

/** The subtitle for a counter row: what kind of thing it is, then how old its reading is. */
export function sensorSubtitle(display: DisplaySensor, now: number): string {
  return `Automated counter · ${stalenessSentence(display, now)}`;
}
