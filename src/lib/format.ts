/**
 * INTEGRATION NOTES (src/lib/format.ts)
 *
 * Display formatting for a `LocationProperties`. Pure and locale-explicit: no caller has
 * to configure `Intl` and no output depends on the visitor's browser locale.
 *
 * Dates are the reason for most of the care here. The contract publishes
 * `YYYY-MM-DD` calendar dates, which have no time zone. Passing such a string to
 * `new Date(...)` and formatting it locally reinterprets it in the visitor's zone and can
 * silently shift the day. Everything below constructs a UTC instant from the parsed
 * fields and formats it with `timeZone: 'UTC'`, so `2030-06-12` always reads "Jun 12,
 * 2030" everywhere.
 *
 * Public surface:
 *   ROADWAY_SEASON_START, ROADWAY_SEASON_END, ROADWAY_SEASON_NOTE, roadwaySeasonNote
 *   isRoadwaySeasonal(type), formatStreet, formatLocality, formatCityLine, formatAddress,
 *   formatAddressLines, formatDate, formatDateRange, formatLicensePeriod, formatCount,
 *   formatUpdatedAt, formatBoroughCount
 *
 * `describeType` is NOT here on purpose: the dining-type vocabulary is owned by
 * `src/map/style.ts` so the map, the legend and the detail sheet cannot drift.
 */

import type { DiningType, LocationProperties } from '../types/location';
import type { DatasetMetadata } from '../types/location';

/**
 * The official DOT window (docs/data-dictionary.md §3): roadway cafes may operate from
 * April 1 through November 29. Quoted from the source, not invented.
 */
export const ROADWAY_SEASON_START = 'April 1';
export const ROADWAY_SEASON_END = 'November 29';
export const ROADWAY_SEASON_NOTE = `Roadway dining may operate from ${ROADWAY_SEASON_START} through ${ROADWAY_SEASON_END}.`;

export function roadwaySeasonNote(type: DiningType): string | null {
  return type === 'roadway' || type === 'both' ? ROADWAY_SEASON_NOTE : null;
}

export function isRoadwaySeasonal(type: DiningType): boolean {
  return type === 'roadway' || type === 'both';
}

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

const DATE_FORMATTER = new Intl.DateTimeFormat('en-US', {
  year: 'numeric',
  month: 'short',
  day: 'numeric',
  timeZone: 'UTC',
});

const DATETIME_FORMATTER = new Intl.DateTimeFormat('en-US', {
  year: 'numeric',
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
  timeZone: 'UTC',
});

const COUNT_FORMATTER = new Intl.NumberFormat('en-US');

/** `919 FULTON STREET` — the source's own case, never case-folded. */
export function formatStreet(properties: LocationProperties): string {
  return properties.street;
}

/**
 * The source's `city` column is really a neighbourhood ("FOREST HILLS"). Shown verbatim in
 * the source's case, falling back to the borough when the column is null.
 */
export function formatLocality(properties: LocationProperties): string {
  return properties.neighborhood ?? properties.borough;
}

export function formatCityLine(properties: LocationProperties): string {
  return `${properties.borough}, NY ${properties.zip}`;
}

/** Single-line address for list rows and share text. */
export function formatAddress(properties: LocationProperties): string {
  return `${formatStreet(properties)}, ${formatCityLine(properties)}`;
}

/** Address split into lines for the detail sheet; drops empty trailing lines. */
export function formatAddressLines(properties: LocationProperties): string[] {
  return [formatStreet(properties), formatLocality(properties), formatCityLine(properties)].filter(
    (line) => line.trim().length > 0,
  );
}

/**
 * `"Jun 12, 2026"` from a `YYYY-MM-DD` contract value, or `null` for null/invalid input.
 * Never throws and never reinterprets the day.
 */
export function formatDate(value: string | null | undefined): string | null {
  const parsed = parseCalendarDate(value);
  return parsed === null ? null : DATE_FORMATTER.format(parsed);
}

/** `"Jun 12, 2026 – Jun 12, 2030"`, degrading gracefully when a bound is missing. */
export function formatDateRange(
  from: string | null | undefined,
  to: string | null | undefined,
): string | null {
  const start = formatDate(from);
  const end = formatDate(to);
  if (start === null && end === null) return null;
  if (start === null) return end;
  if (end === null) return start;
  return `${start} – ${end}`;
}

/** The licence line under the name in the detail sheet. */
export function formatLicensePeriod(properties: LocationProperties): string {
  const issued = formatDate(properties.licenseIssued);
  const expires = formatDate(properties.licenseExpires);
  if (issued === null && expires === null) return 'Licence dates not published';
  if (issued === null) return `Expires ${expires ?? ''}`.trim();
  if (expires === null) return `Issued ${issued}`;
  return `Issued ${issued} · expires ${expires}`;
}

export function formatCount(count: number, singular: string, plural = `${singular}s`): string {
  const formatted = COUNT_FORMATTER.format(count);
  return count === 1 ? `${formatted} ${singular}` : `${formatted} ${plural}`;
}

export function formatPluralizedCount(count: number, singular: string, plural: string): string {
  return `${COUNT_FORMATTER.format(count)} ${count === 1 ? singular : plural}`;
}

export function formatBoroughCount(count: number): string {
  return formatPluralizedCount(count, 'place', 'places');
}

/**
 * "Data updated Sep 27, 2026, 6:15 AM" from `metadata.retrievedAt`. Stream C should render
 * this instead of a hard-coded date (docs/basemap.md). `null` when metadata is absent.
 */
export function formatUpdatedAt(metadata: DatasetMetadata | null): string | null {
  if (!metadata) return null;
  const timestamp = Date.parse(metadata.retrievedAt);
  if (!Number.isFinite(timestamp)) return null;
  return `Data updated ${DATETIME_FORMATTER.format(new Date(timestamp))} UTC`;
}

function parseCalendarDate(value: string | null | undefined): Date | null {
  if (typeof value !== 'string') return null;
  const match = DATE_PATTERN.exec(value);
  if (match === null) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  // Date.UTC maps out-of-range days onto the next month, so verify the round trip.
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  return date;
}
