/**
 * INTEGRATION NOTES (src/features/walk/legend.ts)
 *
 * `LegendConfig` for Where NYC Walks, plus the layer toggles and the sort definitions the
 * shell needs and the registry has no field for.
 *
 * THE `note` IS THE POINT
 * -----------------------
 * `LegendConfig.note` is a required field and the registry's own comment says why: a reader
 * who sees 118 dots has to be told those are measurement points. The sentence below is
 * rendered INSIDE the legend, not in a help page, because a help page is a page nobody opens
 * and the misreading this prevents is the one a first-time visitor makes in the two seconds
 * the map is on screen. It says three separate things, and all three are needed:
 *
 *   1. Activity is shown ONLY where DOT measured it. The dots are the measurement points.
 *   2. The 114 survey sites and the 4 counters are DIFFERENT programs and are not
 *      comparable — a survey total is three periods of one afternoon, a counter total is
 *      fifteen minutes at one hour.
 *   3. The automated feed is a daily batch, not a live stream, so no dot on this map is
 *      "right now".
 *
 * `aboutHref` points at the DATASET the legend describes, taken from the artifact's own
 * `source` field rather than typed here — a URL written in two places is a URL that drifts.
 *
 * The methodology document is `docs/where-nyc-walks.md`, and it exists. It is not PUBLISHED:
 * `public/` carries only the data artifacts, so there is no URL for it, and a link to a path
 * the deployment does not serve is a broken promise in the one place the feature asks to be
 * trusted. So the link goes to the NYC Open Data page, which is public, stable, and is the
 * thing the doc is about. `WALK_ABOUT_HREF_OVERRIDE` is the single line to change when a copy
 * of the doc is published under `public/docs/`, and the link text in `WalkLegend.tsx` is the
 * other half of that change.
 *
 * WHY NINE SWATCHES. Four trends, five activities — and the fifth activity is the one that
 * is not a level. A legend of four coloured dots next to a counter labelled "Quiet" when the
 * bucket was empty is the failure this file is built to prevent, so the grey "No recent
 * reading" swatch is in the legend in its own right, with its own colour and its own words.
 *
 * Public surface:
 *   WALK_IDENTITY, WALK_NOUNS, WALK_COPY
 *   WALK_ABOUT_HREF_OVERRIDE, walkLegend, WALK_LAYER_TOGGLES, WalkLayerToggle
 *   LAYER_TITLES
 */

import type { FeatureCopy, FeatureIdentity, LegendConfig, Nouns, WalkLayerId } from '../registry';
import { ACTIVITY_STYLE_LIST, TREND_STYLE_LIST } from './style';

/**
 * The name the switcher, the document title and `?mode=walk` all read. Exported from here
 * rather than from `feature.ts` because the catalog has to render the switcher's two options
 * — names and descriptions — before either feature has any data, so it must be able to import
 * a name without constructing a feature.
 */
export const WALK_IDENTITY: FeatureIdentity = {
  id: 'walk',
  label: 'Where NYC Walks',
  description: 'Where NYC DOT has counted pedestrians, and when.',
  attribution: 'NYC DOT · Bi-Annual Pedestrian Counts and automated counters',
};

/**
 * The noun every count in this feature is built from. "114 survey sites" is a claim about
 * this dataset specifically — 114 fixed points where a person counted by hand — and the
 * shell builds the count but has no business choosing the word.
 */
export const WALK_NOUNS: Nouns = { one: 'count site', many: 'count sites' };

/**
 * The sentences the shell's cards and the map region are made of.
 *
 * `mapLabel` names the map, which is a map of measurement points. The loading sentence says
 * which artifacts are coming, because "walking data" is not a thing anyone can picture; and
 * the failure sentence refuses the obvious misreading, which is that a blank map means
 * nobody has ever counted pedestrians anywhere.
 *
 * `filtering` is UNREACHABLE for this feature, and it is here anyway. The empty state's
 * "no X matches this combination of …" branch is only rendered when `rows.filtered` is
 * true, and `walkRows` always reports false because there are no dimensions to filter by.
 * The strings are honest anyway rather than left empty, because a `FeatureCopy` with a hole
 * in it is a hole the next feature will fall through.
 */
export const WALK_COPY: FeatureCopy = {
  mapLabel: 'Map of Where NYC DOT has counted pedestrians in New York City',
  data: {
    loading: {
      title: 'Loading walk data',
      body:
        'Fetching the manual survey sites and the automated counters published by NYC DOT. ' +
        'This runs once and is then cached by the browser.',
    },
    failure: {
      title: 'The walk data did not load',
      body:
        'Nothing is shown, because a blank map would look like “nobody has ever counted ' +
        'pedestrians here”, which is not a thing this app is able to tell you.',
    },
  },
  filtering: {
    dimensions: 'survey period and borough',
    retryHint: 'Try a different survey period, or a different borough.',
  },
};

/**
 * The methodology page, when one is PUBLISHED. Empty means "use the dataset's own source URL".
 *
 * `docs/where-nyc-walks.md` is the methodology document and is in the repository, but
 * `public/` serves only the data artifacts, so there is nothing to link to. Set this to
 * `'docs/where-nyc-walks.html'` (relative, so a repository subpath deploy works) once a copy
 * of the doc is built into `public/`.
 */
export const WALK_ABOUT_HREF_OVERRIDE = '';

/** The two dataset names, so the toggles and the provenance cannot say different things. */
export const LAYER_TITLES: Readonly<Record<WalkLayerId, string>> = {
  historical: 'DOT manual survey sites',
  sensors: 'DOT automated counters',
};

export interface WalkLayerToggle {
  readonly id: WalkLayerId;
  readonly label: string;
  /** What turning this off removes, in words. Printed beside the control. */
  readonly help: string;
  /** Which of the two programs it is, for the map's accessible layer description. */
  readonly program: 'manual survey' | 'automated counter';
}

export const WALK_LAYER_TOGGLES: readonly WalkLayerToggle[] = [
  {
    id: 'historical',
    label: 'Survey sites',
    help: '114 screenlines DOT counts by hand, two or three times a year, 2007 to 2026.',
    program: 'manual survey',
  },
  {
    id: 'sensors',
    label: 'Automated counters',
    help: '4 physical counters. A daily batch, not a live feed — see the note below.',
    program: 'automated counter',
  },
];

/**
 * The honesty sentence. Required by the registry, and the whole reason the legend exists
 * next to the map rather than behind a "?" — see the module header.
 */
export const WALK_LEGEND_NOTE =
  'Pedestrian activity is shown only where NYC DOT measured it. These dots are the measurement ' +
  'points — 114 manual survey sites and 4 automated counters — not a description of foot traffic ' +
  'between them. A survey total is one afternoon counted by hand; a counter total is one 15-minute ' +
  'bucket, and those are not the same number. The counter feed is written by a daily batch, so no dot ' +
  'here is a live "right now", and a counter with no recent reading says so rather than "quiet".';

/**
 * The legend, for a loaded dataset.
 *
 * `source` is the artifact's own source URL, so the "about" link is the dataset this legend
 * is describing and stays correct if the pipeline republishes under a new Socrata id.
 *
 * `latestUnavailable` appends a fourth clause to the note. It is its own sentence rather than
 * a console warning because `latest.json` is the only artifact whose absence changes what the
 * note can claim, and a legend that quietly said the same words with one fewer fact behind
 * them would be the dishonest option.
 */
export function walkLegend(source: string | null, latestUnavailable = false): LegendConfig {
  const useSource = WALK_ABOUT_HREF_OVERRIDE === '' && source !== null && source !== '';
  const about = useSource ? (source ?? '') : WALK_ABOUT_HREF_OVERRIDE;

  const note = latestUnavailable
    ? `${WALK_LEGEND_NOTE} The newest automated readings could not be loaded, so no counter is claiming an activity.`
    : WALK_LEGEND_NOTE;

  return {
    title: 'Where NYC Walks',
    swatches: [
      ...TREND_STYLE_LIST.map((style) => ({
        id: `trend-${style.trend}`,
        label: `${style.label} — survey site`,
        color: style.color,
        // The shape, in words, because colour is the redundant channel and never the only one.
        symbol: `Solid circle, ${style.shapeDescription.toLowerCase()}. A survey site's colour is the direction of its change since its first survey.`,
      })),
      ...ACTIVITY_STYLE_LIST.map((style) => ({
        id: `activity-${style.activity}`,
        label: `${style.label} — automated counter`,
        color: style.color,
        symbol: style.isLevel
          ? `A ring around a small core, not a solid circle — a counter is never a survey site. ${style.shapeDescription}. Relative to this counter's own history, never to the city.`
          : `A ring around an empty middle, with an x. ${style.shapeDescription}. This is a missing measurement, not a low one.`,
      })),
    ],
    note,
    ...(about === '' ? {} : { aboutHref: about }),
  };
}
