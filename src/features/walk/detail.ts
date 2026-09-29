/**
 * INTEGRATION NOTES (src/features/walk/detail.ts)
 *
 * The detail sheet's content, as pre-formatted strings, which is what `FeatureDetail` in
 * `src/features/registry.ts` asks for. The shell owns the sheet's chrome, its focus trap and
 * its close button; this owns the words. No formatting decision is made twice, because every
 * sentence comes from `wording.ts` and every colour from `style.ts`.
 *
 * TWO DATASETS, TWO SHEETS, and never a blend
 * -------------------------------------------
 * A survey site and a counter are different measurements of different things, and the sheet
 * for each is built separately rather than from a shared fact list. A sheet that showed the
 * same "count" row for both would be asserting they are comparable, which
 * `src/types/walk.ts` says in so many words: a "busy" label from one is not a "busy" label
 * from the other.
 *
 * THE HEADLINE IS THE MOST IMPORTANT STRING ON THE SHEET
 * -----------------------------------------------------
 * For a survey site it is the DATE — "Surveyed May 2026" — because `am`/`md`/`pm`/`total`
 * are that one afternoon and a number without its date is a claim about a place rather than
 * about a day. For a counter it is the FRESHNESS — "Last reading 14 hours ago", "Offline
 * since 7 June 2026", "No recent reading" — because the count is either an hour old or a
 * fortnight old or absent, and that difference is the whole story.
 *
 * WHAT IS DELIBERATELY ABSENT, and it is a long list, because the source has none of it: no
 * rating, no "how busy compared to other streets", no hours, no recommendation, no ranking
 * position, no "typical day". The trend is stated as what was compared over what span. The
 * Pedestrian Volume Index flag appears only when it is set, because an always-present
 * "no" would be noise about a field the visitor did not ask about.
 *
 * Public surface:
 *   historicalDetail, sensorDetail, walkDetail, surveySeries
 */

import type { FeatureDetail, FeatureSeries } from '../registry';
import type { HistoricalProperties, SensorProperties } from '../../types/walk';
import type { WalkItem, WalkLatestSensor, WalkPatterns } from '../../data/walk/validate';
import { displaySensor } from './display';
import type { DisplaySensor } from './display';
import {
  activityWord,
  boroughLine,
  changeLine,
  countLine,
  expectedLine,
  formatPedestrians,
  historicalCaveat,
  percentileLine,
  pviLine,
  sensorCaveat,
  stalenessSentence,
  surveyHeadline,
  trendBadge,
  yearsLine,
} from './wording';

const PEDESTRIAN_UNIT = 'pedestrians';

interface Fact {
  readonly label: string;
  readonly value: string;
}

/**
 * The survey series, for the chart. `discrete: true` is the load-bearing field: it is what
 * tells any renderer not to connect two surveys with a line, and the registry's own comment
 * says so. The points are the published surveys in the published order, one point per
 * survey, with a null value for any period the source did not measure — a gap in the data
 * rather than a bar of height zero.
 */
export function surveySeries(patterns: WalkPatterns, id: string): FeatureSeries | undefined {
  const site = patterns.sites.get(id);
  if (site === undefined) return undefined;

  return {
    title: 'Every manual survey at this site',
    points: site.surveys.map((survey) => ({
      label: survey.label,
      // An incomplete survey's `total` is the sum of the periods that WERE measured — 2 of 3
      // where every other bar is 3 of 3. Plotting it would make a partial count read as a
      // quieter day, so it is a gap in the series rather than a short bar, and
      // `chartTextAlternative` says how many are missing and why.
      value: survey.complete ? survey.total : null,
    })),
    discrete: true,
    unit: PEDESTRIAN_UNIT,
  };
}

/**
 * A survey site's sheet.
 *
 * The order of the facts is the order a reader wants them: what was counted, when, in which
 * periods, how it compares over time, and how long the record behind that comparison is.
 */
export function historicalDetail(
  properties: HistoricalProperties,
  patterns: WalkPatterns,
): FeatureDetail {
  const facts: Fact[] = [
    { label: 'Survey date', value: properties.latestSurvey ?? 'Never surveyed' },
    { label: 'Morning (am)', value: formatPedestrians(properties.am) },
    { label: 'Midday (md)', value: formatPedestrians(properties.md) },
    { label: 'Evening (pm)', value: formatPedestrians(properties.pm) },
    { label: 'Total at the survey', value: formatPedestrians(properties.total) },
    { label: 'Change since the first survey', value: changeLine(properties) },
    { label: 'Record length', value: yearsLine(properties) },
    { label: 'Direction', value: `${trendBadge(properties.trend)} — ${properties.trend === 'insufficient' ? 'too few surveys to call a direction' : 'compares the first and most recent complete surveys'}` },
    { label: 'Borough', value: boroughLine(properties.borough) },
  ];

  if (properties.crossStreet !== null) {
    facts.push({ label: 'Cross street', value: properties.crossStreet });
  }

  const pvi = pviLine(properties);
  if (pvi !== null) facts.push({ label: 'Pedestrian Volume Index', value: pvi });

  const series = surveySeries(patterns, properties.id);

  return {
    title: properties.name,
    headline: surveyHeadline(properties),
    facts,
    ...(series === undefined ? {} : { series }),
    caveat: historicalCaveat(properties),
  };
}

/**
 * A counter's sheet.
 *
 * Note what is NOT here: the raw `percentile` when the baseline is empty, and any level when
 * there is no reading. Both are refused upstream in `display.ts`, so by the time this
 * function runs, `display.hasLevel` is a fact about the DATA and not a formatting choice.
 */
export function sensorDetail(
  properties: SensorProperties,
  latest: WalkLatestSensor | null,
  now: number,
): FeatureDetail {
  const display: DisplaySensor = displaySensor(properties, latest);

  const facts: Fact[] = [
    { label: 'What it is', value: 'An automated counter, not a manual survey' },
    { label: 'Latest 15-minute bucket', value: countLine(display) },
    { label: 'Usually at this time', value: expectedLine(display) },
    { label: 'Activity', value: activityWord(display) },
    { label: 'Counter serial', value: properties.counterSerial },
    { label: 'Borough', value: boroughLine(properties.borough) },
  ];

  // The direction split is a property of the source's schema, and it changes what the number
  // means, so it is stated rather than left for the reader to guess from a total.
  facts.push({
    label: 'Direction',
    value: properties.directional
      ? 'Counted in and out separately by the source'
      : 'Counted as a single total',
  });

  const percentile = percentileLine(display);
  if (percentile !== null) facts.push({ label: 'Against its own history', value: percentile });

  if (properties.observationCount > 0) {
    facts.push({ label: 'Observations behind the baseline', value: String(properties.observationCount) });
  }

  if (display.staleness === 'offline' || display.staleness === 'unavailable') {
    facts.push({ label: 'Last recorded observation', value: stalenessSentence(display, now) });
  }

  return {
    title: properties.name,
    headline: stalenessSentence(display, now),
    facts,
    // A counter has no series: the artifact publishes 4 107 manual surveys and 21 million
    // automated rows, and neither is a series this feature is allowed to draw as a line. The
    // automated feed is a daily batch of 15-minute buckets, not a time series a reader can
    // read a trend off, and a "recent hours" sparkline drawn from a truncated day would
    // imply a shape the batch never published.
    caveat: sensorCaveat(display),
  };
}

/**
 * The detail for one id, or null for an id this feature does not have.
 *
 * The null is load-bearing: the shell holds ONE selection id across both features, so a
 * selection left over from the eat feature arrives here and must clear rather than render as
 * an empty sheet. It also covers an id that has been renamed by a pipeline run, which is the
 * other way a stale selection happens.
 */
export function walkDetail(
  item: WalkItem | undefined,
  patterns: WalkPatterns | null,
  latestById: ReadonlyMap<string, WalkLatestSensor>,
  now: number,
): FeatureDetail | null {
  if (item === undefined) return null;
  if (item.kind === 'historical') {
    if (patterns === null) return null;
    return historicalDetail(item.properties, patterns);
  }
  return sensorDetail(item.properties, latestById.get(item.properties.id) ?? null, now);
}
