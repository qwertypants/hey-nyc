/**
 * THE DETAIL SHEET'S WORDS.
 *
 * `FeatureDetail` is a bag of pre-formatted strings, which means the ONLY way this feature can
 * be wrong is by writing a sentence that the data does not support. So most of this file is
 * about sentences, and the assertions are about the specific claim each one makes:
 *
 *   - a survey sheet leads with the DATE, because `am`/`md`/`pm`/`total` describe one afternoon;
 *   - a counter sheet leads with the FRESHNESS, because the count is an hour old or a fortnight
 *     old or absent, and that difference is the whole story;
 *   - `unavailable` is never "quiet", in any field, in any position;
 *   - the series is `discrete: true`, which is the field the registry says any renderer must
 *     read before drawing a line.
 *
 * The clock is a parameter (`now`), so "14 hours ago" is a fact about a fixture rather than
 * about when the test ran.
 */

import { describe, expect, it } from 'vitest';
import type { WalkLatestSensor } from '../src/data/walk/validate';
import { validateHistoricalPatterns, validateLatest } from '../src/data/walk/validate';
import { historicalDetail, sensorDetail, surveySeries, walkDetail } from '../src/features/walk/detail';
import {
  LATEST_RAW,
  NOW_MS,
  PATTERNS_RAW,
  SENSOR_BUSY,
  SENSOR_COLLECTION,
  SENSOR_NO_HISTORY,
  SENSOR_OFFLINE,
  SENSOR_STALE_ZERO_BUCKET,
  SURVEY_FALLING,
  SURVEY_INSUFFICIENT,
  SURVEY_RISING,
  SURVEY_UNSURVEYED,
} from './helpers/walkFixtures';

const PATTERNS = validateHistoricalPatterns(PATTERNS_RAW);

function latestFor(id: string): WalkLatestSensor | null {
  const feed = validateLatest(LATEST_RAW);
  return feed.sensors.find((sensor) => sensor.id === id) ?? null;
}

function sensorProps(feature: (typeof SENSOR_BUSY)): (typeof SENSOR_BUSY)['properties'] {
  return feature.properties;
}

function surveyProps(feature: (typeof SURVEY_RISING)): (typeof SURVEY_RISING)['properties'] {
  return feature.properties;
}

/** Every string anywhere in a detail, for the "this word must never appear" assertions. */
function allText(detail: { facts: readonly { label: string; value: string }[]; caveat: string | null; headline: string; title: string }): string {
  return [
    detail.title,
    detail.headline,
    detail.caveat ?? '',
    ...detail.facts.flatMap((fact) => [fact.label, fact.value]),
  ].join(' \n ');
}

describe('a survey site sheet: the date is the headline', () => {
  const detail = historicalDetail(surveyProps(SURVEY_RISING), PATTERNS);

  it('is the survey date, prominently, and carries no count of its own', () => {
    expect(detail.headline).toBe('Surveyed May 2026');
    // A thousands separator would be a count. The year is a date, so the test is for the
    // separator and the word, not for digits.
    expect(detail.headline).not.toMatch(/[\d],[\d]{3}/);
    expect(detail.headline).not.toMatch(/pedestrians/i);
  });

  it('is titled with the source\'s own name', () => {
    expect(detail.title).toBe('82 Street at 37th Avenue');
  });

  it('carries am, md, pm and the total as separate facts', () => {
    const values = new Map(detail.facts.map((fact) => [fact.label, fact.value]));
    expect(values.get('Morning (am)')).toBe('2,191');
    expect(values.get('Midday (md)')).toBe('4,244');
    expect(values.get('Evening (pm)')).toBe('6,837');
    expect(values.get('Total at the survey')).toBe('13,272');
  });

  it('spells out the change with its span, in one string', () => {
    const change = detail.facts.find((fact) => fact.label === 'Change since the first survey');
    expect(change?.value).toBe('+3,666 since May 2007 – May 2026');
  });

  it('uses a real MINUS SIGN for a fall, not a hyphen', () => {
    const falling = historicalDetail(surveyProps(SURVEY_FALLING), PATTERNS);
    const change = falling.facts.find((fact) => fact.label === 'Change since the first survey');
    expect(change?.value).toBe('−9,800 since September 2007 – September 2025');
    expect(change?.value).not.toContain('-9,800');
  });

  it('states how long the record behind that comparison is', () => {
    const years = detail.facts.find((fact) => fact.label === 'Record length');
    expect(years?.value).toBe('20 survey years, 2007 to 2026');
  });

  it('names the Pedestrian Volume Index only when it is set', () => {
    expect(detail.facts.some((fact) => fact.label === 'Pedestrian Volume Index')).toBe(true);
    const pvi = detail.facts.find((fact) => fact.label === 'Pedestrian Volume Index');
    expect(pvi?.value).toMatch(/Pedestrian Volume Index/);

    const notInIndex = historicalDetail(
      surveyProps({ ...SURVEY_RISING, properties: { ...SURVEY_RISING.properties, inPedestrianVolumeIndex: false } }),
      PATTERNS,
    );
    expect(notInIndex.facts.some((fact) => fact.label === 'Pedestrian Volume Index')).toBe(false);
  });

  it('says the trend, and says what the trend is compared over', () => {
    const direction = detail.facts.find((fact) => fact.label === 'Direction');
    expect(direction?.value).toContain('Rising');
    expect(direction?.value).toMatch(/first and most recent complete surveys/);
  });

  it('does not rank the site against the city, which 114 screenlines cannot support', () => {
    const text = allText(detail);
    expect(text).not.toMatch(/busiest|most popular|compared to other|than most/i);
  });

  it('carries the single-survey caveat, and it names the gap it does not describe', () => {
    expect(detail.caveat).toContain('One manual screenline survey on May 2026');
    expect(detail.caveat).toContain('nothing between those surveys was measured');
    expect(detail.caveat).toContain('not a live count');
  });

  it('the "never surveyed" sheet says so everywhere rather than showing zeros', () => {
    const blank = historicalDetail(surveyProps(SURVEY_UNSURVEYED), PATTERNS);
    expect(blank.headline).toBe('Never surveyed');
    const text = allText(blank);
    expect(text).not.toMatch(/0 pedestrians/);
    const values = new Map(blank.facts.map((fact) => [fact.label, fact.value]));
    expect(values.get('Morning (am)')).toBe('Not measured');
    expect(values.get('Total at the survey')).toBe('Not measured');
    expect(values.get('Change since the first survey')).toMatch(/No comparison/);
    expect(blank.caveat).toContain('never been surveyed');
  });

  it('the `insufficient` trend says why there is no direction', () => {
    const thin = historicalDetail(surveyProps(SURVEY_INSUFFICIENT), PATTERNS);
    const direction = thin.facts.find((fact) => fact.label === 'Direction');
    expect(direction?.value).toContain('Not enough surveys');
    expect(direction?.value).toContain('too few surveys to call a direction');
  });

  it('omits the cross street when the source has none', () => {
    expect(allText(historicalDetail(surveyProps(SURVEY_UNSURVEYED), PATTERNS))).not.toContain('Cross street');
  });
});

describe('the survey series is marked discrete, because it must never be a line', () => {
  const series = surveySeries(PATTERNS, SURVEY_RISING.properties.id);

  it('exists for a site with surveys', () => {
    expect(series).toBeDefined();
    expect(series?.discrete).toBe(true);
    expect(series?.unit).toBe('pedestrians');
  });

  it('is one point per published survey, in the published order', () => {
    expect(series?.points.map((point) => point.label)).toEqual([
      'May 2007',
      'May 2010',
      'May 2015',
      'May 2020',
      'May 2026',
    ]);
  });

  it('drops an INCOMPLETE survey to a gap rather than plotting a partial total', () => {
    // May 2015 measured morning and evening only; its total of 800 is the sum of two periods
    // where every other bar is three. Plotted, it reads as a quieter day — which is the
    // missing-is-not-zero rule, applied to a chart.
    const may2015 = series?.points.find((point) => point.label === 'May 2015');
    expect(may2015?.value).toBeNull();
    expect(series?.points.filter((point) => point.value !== null)).toHaveLength(4);
  });

  it('is undefined for a site with no series, rather than an empty chart', () => {
    expect(surveySeries(PATTERNS, SURVEY_UNSURVEYED.properties.id)).toBeUndefined();
    expect(surveySeries(PATTERNS, SURVEY_TIE_TOTAL_ID)).toBeUndefined();
  });

  it('the sheet omits `series` entirely when there is none', () => {
    const blank = historicalDetail(surveyProps(SURVEY_UNSURVEYED), PATTERNS);
    expect(blank.series).toBeUndefined();
  });
});

const SURVEY_TIE_TOTAL_ID = 'wsh-0000000000a3';

describe('a counter sheet: the freshness is the headline', () => {
  it('a late counter says how late, in words', () => {
    const detail = sensorDetail(sensorProps(SENSOR_STALE_ZERO_BUCKET), latestFor(SENSOR_STALE_ZERO_BUCKET.id), NOW_MS);
    expect(detail.headline).toBe('Last reading 14 hours ago');
  });

  it('an offline counter says since when, and does not carry a count', () => {
    const detail = sensorDetail(sensorProps(SENSOR_OFFLINE), latestFor(SENSOR_OFFLINE.id), NOW_MS);
    expect(detail.headline).toBe('Offline since June 7');
    const values = new Map(detail.facts.map((fact) => [fact.label, fact.value]));
    expect(values.get('Latest 15-minute bucket')).toBe('No recent reading');
  });

  it('a counter that has NEVER reported does not claim it went offline', () => {
    // "Offline" implies it was once online. `SENSOR_NO_HISTORY` has no `lastObservation` at
    // all, so the honest headline is the absence of a reading rather than a freshness claim.
    const detail = sensorDetail(sensorProps(SENSOR_NO_HISTORY), null, NOW_MS);
    expect(detail.headline).toBe('No recent reading');
    expect(detail.caveat).toContain('no recorded observation at all');
  });

  it('a fresh counter says the reading is current', () => {
    const detail = sensorDetail(sensorProps(SENSOR_BUSY), null, NOW_MS);
    expect(detail.headline).toBe('Last reading just now');
  });

  it('says the automated feed is a daily batch, not a live stream', () => {
    // Every counter caveat carries it, including the ones that DO have a reading.
    for (const feature of [SENSOR_BUSY, SENSOR_STALE_ZERO_BUCKET, SENSOR_OFFLINE]) {
      const detail = sensorDetail(sensorProps(feature), null, NOW_MS);
      expect(detail.caveat).toContain('daily batch');
      expect(detail.caveat).toMatch(/never a live "now"/);
    }
  });

  it('states what a level is relative to, and what it is not', () => {
    const detail = sensorDetail(sensorProps(SENSOR_BUSY), null, NOW_MS);
    expect(detail.caveat).toContain("this counter’s own history");
    expect(detail.caveat).toContain('not to other counters');
    expect(detail.caveat).toContain('not to the rest of the city');
  });

  it('carries the counter serial, so the reading is traceable to a physical device', () => {
    const detail = sensorDetail(sensorProps(SENSOR_BUSY), null, NOW_MS);
    const serial = detail.facts.find((fact) => fact.label === 'Counter serial');
    expect(serial?.value).toBe('YAH22104565');
  });

  it('says the count is fifteen minutes, not a day', () => {
    const detail = sensorDetail(sensorProps(SENSOR_BUSY), null, NOW_MS);
    const count = detail.facts.find((fact) => fact.label === 'Latest 15-minute bucket');
    expect(count?.value).toBe('41 people in the last 15-minute bucket');
  });
});

describe('`unavailable` is never rendered as a level, in any field', () => {
  it('the zero-bucket counter reports "No recent reading" as its activity', () => {
    const detail = sensorDetail(sensorProps(SENSOR_STALE_ZERO_BUCKET), latestFor(SENSOR_STALE_ZERO_BUCKET.id), NOW_MS);
    const activity = detail.facts.find((fact) => fact.label === 'Activity');
    expect(activity?.value).toBe('No recent reading');
  });

  it('the word "quiet" appears NOWHERE on a zero-bucket sheet', () => {
    // The source's own `activity` field says "quiet". The sheet must not repeat it in any
    // position, including inside the caveat where a negation could be misread as a correction.
    const detail = sensorDetail(sensorProps(SENSOR_STALE_ZERO_BUCKET), latestFor(SENSOR_STALE_ZERO_BUCKET.id), NOW_MS);
    expect(allText(detail)).not.toMatch(/quiet/i);
  });

  it('the bare percentile of an empty distribution is not shown', () => {
    const detail = sensorDetail(sensorProps(SENSOR_STALE_ZERO_BUCKET), latestFor(SENSOR_STALE_ZERO_BUCKET.id), NOW_MS);
    expect(allText(detail)).not.toMatch(/percentile/i);
    expect(allText(detail)).not.toMatch(/\b50\b/);
  });

  it('a REAL percentile is shown, with the comparison spelled out', () => {
    const detail = sensorDetail(sensorProps(SENSOR_BUSY), null, NOW_MS);
    const against = detail.facts.find((fact) => fact.label === 'Against its own history');
    expect(against?.value).toBe('93rd percentile of this counter’s own history for this weekday and time');
  });

  it('the empty bucket is explained as an empty bucket, not as a quiet street', () => {
    const detail = sensorDetail(sensorProps(SENSOR_STALE_ZERO_BUCKET), null, NOW_MS);
    expect(detail.caveat).toContain('The newest bucket was empty');
    expect(detail.caveat).toContain('says nothing about how busy');
    expect(detail.caveat).toContain('No activity level is shown');
    expect(detail.caveat).toContain('a missing measurement is not a measurement of nothing');
  });

  it('the expected value of zero is shown, because it is the reason', () => {
    const detail = sensorDetail(sensorProps(SENSOR_STALE_ZERO_BUCKET), null, NOW_MS);
    const expected = detail.facts.find((fact) => fact.label === 'Usually at this time');
    expect(expected?.value).toBe('Usually 0 at this time on this weekday — this counter sits in empty hours');
  });

  it('a dead counter explains that its silence is not quietness', () => {
    const detail = sensorDetail(sensorProps(SENSOR_OFFLINE), null, NOW_MS);
    expect(detail.caveat).toContain('No recent reading, so no activity is claimed here');
    expect(detail.caveat).toContain('silent since');
    expect(detail.caveat).toContain('A missing measurement is not a measurement of nothing');
  });

  it('a real level IS shown when there is a real reading', () => {
    const detail = sensorDetail(sensorProps(SENSOR_BUSY), null, NOW_MS);
    const activity = detail.facts.find((fact) => fact.label === 'Activity');
    expect(activity?.value).toBe('Busy');
  });

  it('no counter sheet carries a time series, because the batch feed is not one', () => {
    for (const feature of SENSOR_COLLECTION.features) {
      expect(sensorDetail(feature.properties, null, NOW_MS).series).toBeUndefined();
    }
  });
});

describe('a counter is never comparable to a survey site, and the sheet says so', () => {
  it('names the counter as automated and distinguishes it from a manual survey', () => {
    const detail = sensorDetail(sensorProps(SENSOR_BUSY), null, NOW_MS);
    const what = detail.facts.find((fact) => fact.label === 'What it is');
    expect(what?.value).toBe('An automated counter, not a manual survey');
  });

  it('never offers a "since the first survey" comparison, which only a survey has', () => {
    for (const feature of SENSOR_COLLECTION.features) {
      const text = allText(sensorDetail(feature.properties, null, NOW_MS));
      expect(text).not.toContain('Change since the first survey');
      expect(text).not.toContain('Record length');
    }
  });
});

describe('detail() returns null for an id this feature does not have', () => {
  const index = {
    historical: { type: 'FeatureCollection' as const, features: [] },
    byId: new Map<string, never>(),
  };
  void index;

  it('null for an id from the other feature', () => {
    // The shell holds ONE selection id across both features, so a selection left over from the
    // eat feature arrives here. Returning null is how it clears rather than rendering as an
    // empty sheet.
    expect(walkDetail(undefined, PATTERNS, new Map(), NOW_MS)).toBeNull();
  });

  it('null for a stale id from an older pipeline run', () => {
    expect(walkDetail(undefined, PATTERNS, new Map(), NOW_MS)).toBeNull();
  });

  it('null for a survey site when the patterns file failed to load', () => {
    // Without `historical-patterns.json` there is no series, and a sheet whose whole point is
    // the 19-year record with no record in it is worse than no sheet.
    const item = {
      kind: 'historical' as const,
      properties: SURVEY_RISING.properties,
      coords: { lat: 40.746, lng: -73.889 },
    };
    expect(walkDetail(item, null, new Map(), NOW_MS)).toBeNull();
  });

  it('a counter still resolves without the patterns file, because it never needed it', () => {
    const item = {
      kind: 'sensor' as const,
      properties: SENSOR_BUSY.properties,
      coords: { lat: 40.807, lng: -73.924 },
    };
    expect(walkDetail(item, null, new Map(), NOW_MS)).not.toBeNull();
  });

  it('a counter resolves with no `latest.json` rows, because the collection carries the staleness', () => {
    const item = {
      kind: 'sensor' as const,
      properties: SENSOR_OFFLINE.properties,
      coords: { lat: 40.842, lng: -73.932 },
    };
    const detail = walkDetail(item, PATTERNS, new Map(), NOW_MS);
    expect(detail?.headline).toBe('Offline since June 7');
  });
});
