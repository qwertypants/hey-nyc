/**
 * INTEGRATION NOTES (src/data/walk/relativeTime.ts)
 *
 * "14 hours ago", "June 2026", "4 May" — the time vocabulary the Where NYC Walks feature
 * speaks in. Pure, `Intl`-pinned, no clock of its own: every function takes the instant to
 * describe and the instant to measure from, so nothing here is a function of when the test
 * happened to run.
 *
 * WHY THIS IS NOT IN `src/lib`. It is a formatter, and `src/lib` is where formatters live, so
 * that is the obvious home. It is not there because the ROUNDING is a wording decision of this
 * feature rather than a shared one: "14 hours" and "3 days" are what a staleness sentence
 * needs to say, and a general-purpose relative-time formatter would round differently and
 * leave the feature and the sentence disagreeing. Keeping it inside `src/data/walk` also keeps
 * this agent's new files off the shell's shared surface.
 *
 * The rounding bands, and why each:
 *   < 60s            "just now"     a reading this new needs no qualifier
 *   < 60m            "N minutes ago"  N to 2dp-free, the only band with a real count
 *   < 24h            "N hours ago"    the band the current dataset lives in (~14h)
 *   < 7d             "N days ago"     past a day, hours stop being the useful unit
 *   < 60d            "N weeks ago"
 *   otherwise        "N months ago", floored at a month, because "1 months ago" is a typo and
 *                    the honest floor is "1 month ago" — a fractional month is a number
 *                    nobody can picture, and a survey site is a 19-year record anyway.
 *
 * Public surface:
 *   formatMonthYear(iso): string | null      "June 2026"
 *   formatDayAndMonth(iso): string | null    "4 May"
 *   formatDateTimeUtc(iso): string | null    "28 Sep 2026, 1:15 AM"
 *   relativeAge(from, now): string           "14 hours ago"
 *   ageInHours(from, now): number | null
 */

const MONTH_YEAR = new Intl.DateTimeFormat('en-US', {
  month: 'long',
  year: 'numeric',
  timeZone: 'UTC',
});

const DAY_MONTH = new Intl.DateTimeFormat('en-US', {
  day: 'numeric',
  month: 'long',
  timeZone: 'UTC',
});

const DATE_TIME_UTC = new Intl.DateTimeFormat('en-US', {
  year: 'numeric',
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
  timeZone: 'UTC',
});

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;
/** 30 days, so "1 month" and "2 months" are 30 and 60 days rather than a real calendar. */
const MONTH_MS = 30 * DAY_MS;

function toInstant(value: string | null | undefined): number | null {
  if (typeof value !== 'string') return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function formatMonthYearParts(instant: number): string {
  return MONTH_YEAR.format(new Date(instant));
}

/** `"June 2026"` from an ISO-8601 instant, or null when there is not one. */
export function formatMonthYear(value: string | null | undefined): string | null {
  const instant = toInstant(value);
  return instant === null ? null : formatMonthYearParts(instant);
}

/** `"4 May"` from an ISO-8601 instant, or null. The day an offline counter last spoke. */
export function formatDayAndMonth(value: string | null | undefined): string | null {
  const instant = toInstant(value);
  return instant === null ? null : DAY_MONTH.format(new Date(instant));
}

/** `"28 Sep 2026, 1:15 AM"` — UTC, and stated as UTC, because the buckets are UTC. */
export function formatDateTimeUtc(value: string | null | undefined): string | null {
  const instant = toInstant(value);
  return instant === null ? null : `${DATE_TIME_UTC.format(new Date(instant))} UTC`;
}

function plural(count: number, unit: string): string {
  return `${count} ${unit}${count === 1 ? '' : 's'}`;
}

/** Whole units elapsed, floored. A clock 30 seconds past the hour has not reached it. */
export function relativeAge(
  from: string | number | null | undefined,
  now: number,
): string {
  const instant = typeof from === 'number' ? (Number.isFinite(from) ? from : null) : toInstant(from);
  if (instant === null) return 'an unknown time ago';

  const elapsed = now - instant;
  if (elapsed < 0) return 'moments from now';
  if (elapsed < MINUTE_MS) return 'just now';
  if (elapsed < HOUR_MS) return `${plural(Math.floor(elapsed / MINUTE_MS), 'minute')} ago`;
  if (elapsed < DAY_MS) return `${plural(Math.floor(elapsed / HOUR_MS), 'hour')} ago`;
  if (elapsed < WEEK_MS) return `${plural(Math.floor(elapsed / DAY_MS), 'day')} ago`;
  if (elapsed < MONTH_MS) return `${plural(Math.floor(elapsed / WEEK_MS), 'week')} ago`;
  return `${plural(Math.floor(elapsed / MONTH_MS), 'month')} ago`;
}

/** The same interval in hours, for anything that needs to decide rather than to speak. */
export function ageInHours(from: string | number | null | undefined, now: number): number | null {
  const instant = typeof from === 'number' ? (Number.isFinite(from) ? from : null) : toInstant(from);
  if (instant === null) return null;
  return (now - instant) / HOUR_MS;
}
