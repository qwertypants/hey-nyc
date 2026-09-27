import { describe, expect, it } from 'vitest';
import {
  ROADWAY_SEASON_END,
  ROADWAY_SEASON_NOTE,
  ROADWAY_SEASON_START,
  formatAddress,
  formatAddressLines,
  formatBoroughCount,
  formatCityLine,
  formatCount,
  formatDate,
  formatDateRange,
  formatLicensePeriod,
  formatLocality,
  formatStreet,
  formatUpdatedAt,
  isRoadwaySeasonal,
  roadwaySeasonNote,
} from '../src/lib/format';
import { describeType } from '../src/map/style';
import type { DatasetMetadata, LocationProperties } from '../src/types/location';

function location(overrides: Partial<LocationProperties> = {}): LocationProperties {
  return {
    id: 'eoy-3f2a1b9c4d5e',
    name: 'EMMY',
    legalName: 'EMH 919 INC',
    street: '919 FULTON STREET',
    neighborhood: null,
    borough: 'Brooklyn',
    zip: '11238',
    type: 'sidewalk',
    status: 'Issued',
    licenseIssued: '2026-06-12',
    licenseExpires: '2030-06-12',
    nta: 'BK0204',
    bbl: '3019770033',
    sid: ['row-1'],
    ...overrides,
  };
}

function metadata(overrides: Partial<DatasetMetadata> = {}): DatasetMetadata {
  return {
    dataset: 'Dining Out NYC Locations',
    datasetId: 'fpeh-f7ci',
    provider: 'NYC DOT',
    source: 'https://data.cityofnewyork.us/resource/fpeh-f7ci.json',
    attribution: 'Department of Transportation (DOT)',
    retrievedAt: '2026-09-27T10:15:00Z',
    sourceUpdatedAt: null,
    recordCount: 2000,
    sourceRowCount: 2431,
    contentHash: 'abc123',
    counts: { sidewalk: 1173, roadway: 396, both: 431 },
    boroughs: { Manhattan: 1000 },
    ...overrides,
  };
}

describe('address composition', () => {
  it('keeps the source case rather than case-folding it', () => {
    expect(formatStreet(location())).toBe('919 FULTON STREET');
  });

  it('treats the source "city" column as a neighbourhood', () => {
    expect(formatLocality(location({ neighborhood: 'FOREST HILLS' }))).toBe('FOREST HILLS');
  });

  it('falls back to the borough when the neighbourhood is null', () => {
    expect(formatLocality(location({ neighborhood: null }))).toBe('Brooklyn');
  });

  it('preserves a leading zero in the zip', () => {
    expect(formatCityLine(location({ borough: 'Manhattan', zip: '10027' }))).toBe(
      'Manhattan, NY 10027',
    );
  });

  it('composes a single-line address', () => {
    expect(formatAddress(location())).toBe('919 FULTON STREET, Brooklyn, NY 11238');
  });

  it('splits the address into sheet lines, skipping the null neighbourhood', () => {
    expect(formatAddressLines(location())).toEqual([
      '919 FULTON STREET',
      'Brooklyn',
      'Brooklyn, NY 11238',
    ]);
    expect(formatAddressLines(location({ neighborhood: 'ASTORIA' }))).toEqual([
      '919 FULTON STREET',
      'ASTORIA',
      'Brooklyn, NY 11238',
    ]);
  });
});

describe('formatDate', () => {
  it('formats a YYYY-MM-DD contract value unambiguously', () => {
    expect(formatDate('2026-06-12')).toBe('Jun 12, 2026');
    expect(formatDate('2026-01-01')).toBe('Jan 1, 2026');
    expect(formatDate('2026-12-31')).toBe('Dec 31, 2026');
  });

  it('does not shift the day, whatever the host time zone', () => {
    // A local-time parse of a bare date is the classic off-by-one-day bug: at UTC-5 a
    // 2026-01-01 midnight parse lands on 2025-12-31 local. UTC-only formatting cannot.
    expect(formatDate('2026-01-01')).toBe('Jan 1, 2026');
    expect(formatDate('2026-01-01')).not.toContain('Dec 31, 2025');
  });

  it('passes null through', () => {
    expect(formatDate(null)).toBeNull();
    expect(formatDate(undefined)).toBeNull();
  });

  it('rejects anything that is not a bare YYYY-MM-DD instead of guessing', () => {
    for (const value of [
      '2026-06-12T00:00:00.000Z',
      '06/12/2026',
      '12 June 2026',
      '2026-6-12',
      '2026-13-01',
      '2026-02-30',
      '',
      'yesterday',
    ]) {
      expect(formatDate(value)).toBeNull();
    }
  });

  it('rejects non-string input without throwing', () => {
    expect(formatDate(20260612 as unknown as string)).toBeNull();
    expect(formatDate({} as unknown as string)).toBeNull();
  });

  it('degrades a range gracefully when one end is missing', () => {
    expect(formatDateRange('2026-06-12', '2030-06-12')).toBe('Jun 12, 2026 – Jun 12, 2030');
    expect(formatDateRange('2026-06-12', null)).toBe('Jun 12, 2026');
    expect(formatDateRange(null, '2030-06-12')).toBe('Jun 12, 2030');
    expect(formatDateRange(null, null)).toBeNull();
  });
});

describe('formatLicensePeriod', () => {
  it('states both ends when both are published', () => {
    expect(formatLicensePeriod(location())).toBe('Issued Jun 12, 2026 · expires Jun 12, 2030');
  });

  it('says so when the source published neither date', () => {
    expect(
      formatLicensePeriod(location({ licenseIssued: null, licenseExpires: null })),
    ).toBe('Licence dates not published');
  });

  it('handles one missing end', () => {
    expect(formatLicensePeriod(location({ licenseExpires: null }))).toBe(
      'Issued Jun 12, 2026',
    );
    expect(formatLicensePeriod(location({ licenseIssued: null }))).toBe('Expires Jun 12, 2030');
  });
});

describe('the roadway season', () => {
  it('quotes the official DOT window verbatim', () => {
    expect(ROADWAY_SEASON_START).toBe('April 1');
    expect(ROADWAY_SEASON_END).toBe('November 29');
    expect(ROADWAY_SEASON_NOTE).toBe(
      'Roadway dining may operate from April 1 through November 29.',
    );
  });

  it('applies to roadway and to both, never to sidewalk alone', () => {
    expect(isRoadwaySeasonal('roadway')).toBe(true);
    expect(isRoadwaySeasonal('both')).toBe(true);
    expect(isRoadwaySeasonal('sidewalk')).toBe(false);
    expect(roadwaySeasonNote('sidewalk')).toBeNull();
    expect(roadwaySeasonNote('both')).toBe(ROADWAY_SEASON_NOTE);
  });
});

describe('counts', () => {
  it('pluralises explicitly and groups thousands', () => {
    expect(formatCount(1, 'place')).toBe('1 place');
    expect(formatCount(2, 'place')).toBe('2 places');
    expect(formatCount(2000, 'place')).toBe('2,000 places');
    expect(formatBoroughCount(0)).toBe('0 places');
    expect(formatBoroughCount(1)).toBe('1 place');
  });
});

describe('formatUpdatedAt', () => {
  it('renders the pipeline timestamp instead of a hard-coded date', () => {
    expect(formatUpdatedAt(metadata())).toBe('Data updated Sep 27, 2026, 10:15 AM UTC');
  });

  it('returns null when metadata is missing or the timestamp is unparseable', () => {
    expect(formatUpdatedAt(null)).toBeNull();
    expect(formatUpdatedAt(metadata({ retrievedAt: 'nope' }))).toBeNull();
  });
});

describe('the dining-type wording lives in exactly one place', () => {
  it('is reachable from the shared vocabulary, not re-invented per surface', () => {
    expect(describeType('sidewalk')).toBe('Sidewalk dining');
    expect(describeType('roadway')).toBe('Roadway dining');
    expect(describeType('both')).toBe('Sidewalk + roadway dining');
  });
});
