/**
 * INTEGRATION NOTES (src/lib/search.ts)
 *
 * Local restaurant-name search over the already-downloaded dataset. NEVER touches the
 * network — the GeoJSON is in memory, so there is nothing to fetch and nothing to rate
 * limit. (Nominatim, in `geocode.ts`, is the only network search and only fires on an
 * explicit submit.)
 *
 * Public surface:
 *   MATCH_NONE, MAX_RESULTS
 *   normalizeText(value: string): string
 *   scoreMatch(candidate: string, query: string): number
 *   searchLocations(locations, query, options?): LocationProperties[]
 *
 * Matching is case- and diacritic-insensitive and covers `name` and `legalName`. Ranking
 * is prefix > word-start > substring, with exact matches beating prefixes; ties break on
 * `name` so the order is stable across runs. Results are capped at `options.limit`
 * (default `MAX_RESULTS`) because the caller only ever renders a short list.
 */

import type { LocationProperties } from '../types/location';

export const MATCH_NONE = -1;
export const MAX_RESULTS = 50;

/** Higher is a better match. Whole-field > prefix > word-start > substring. */
const TIER_EXACT = 400;
const TIER_PREFIX = 300;
const TIER_WORD_START = 200;
const TIER_SUBSTRING = 100;

/** Shorter fields that match the same way rank higher ("CAFE" over "CAFE ON 3RD"). */
const TIER_LONGER_BONUS = 20;

/**
 * Folds case, diacritics and punctuation so "Cafe" matches "CAFÉ" and "joes" matches
 * "JOE'S". Uses NFD then drops combining marks rather than a hand-rolled accent table.
 *
 * Apostrophes are deleted rather than spaced out, because they sit INSIDE a word: a user
 * typing "joes" is looking for "JOE'S PIZZA", not for "JOE S PIZZA".
 */
export function normalizeText(value: string): string {
  return value
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/['\u2018\u2019]/gu, '')
    .replace(/[\p{P}\p{S}]+/gu, ' ')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function scoreSingleTerm(field: string, term: string): number {
  if (field === term) return TIER_EXACT;
  if (field.startsWith(term)) return TIER_PREFIX + Math.max(0, TIER_LONGER_BONUS - field.length);
  if (field.includes(` ${term}`)) return TIER_WORD_START;
  if (field.includes(term)) return TIER_SUBSTRING;
  return MATCH_NONE;
}

/**
 * Best score of `query` against `candidate`, or `MATCH_NONE`.
 * A multi-word query must match every term; its score is the weakest term, so adding a
 * word can never improve a result.
 */
export function scoreMatch(candidate: string, query: string): number {
  const field = normalizeText(candidate);
  const terms = normalizeText(query).split(' ').filter((term) => term.length > 0);
  if (terms.length === 0 || field.length === 0) return MATCH_NONE;

  let best = Number.POSITIVE_INFINITY;
  for (const term of terms) {
    const score = scoreSingleTerm(field, term);
    if (score === MATCH_NONE) return MATCH_NONE;
    best = Math.min(best, score);
  }
  return best;
}

export interface SearchOptions {
  /** Result cap. Non-finite or non-positive values fall back to `MAX_RESULTS`. */
  readonly limit?: number;
}

interface Scored {
  readonly location: LocationProperties;
  readonly score: number;
  readonly name: string;
}

function compare(a: Scored, b: Scored): number {
  if (b.score !== a.score) return b.score - a.score;
  const byName = a.name.localeCompare(b.name, 'en');
  if (byName !== 0) return byName;
  return a.location.id.localeCompare(b.location.id, 'en');
}

export function searchLocations(
  locations: readonly LocationProperties[],
  query: string,
  options: SearchOptions = {},
): LocationProperties[] {
  const requested = options.limit ?? MAX_RESULTS;
  const limit = Number.isFinite(requested) && requested > 0 ? Math.floor(requested) : MAX_RESULTS;

  const needle = query.trim();
  if (needle.length === 0) return [];

  const scored: Scored[] = [];
  for (const location of locations) {
    const score = Math.max(
      scoreMatch(location.name, needle),
      scoreMatch(location.legalName, needle),
    );
    if (score === MATCH_NONE) continue;
    scored.push({ location, score, name: location.name });
  }

  scored.sort(compare);
  return scored.slice(0, limit).map((entry) => entry.location);
}
