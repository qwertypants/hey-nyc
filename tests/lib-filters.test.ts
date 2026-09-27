import { describe, expect, it } from 'vitest';
import {
  NO_FILTER,
  applyFilters,
  boroughOptions,
  countByBorough,
  countByType,
  countFor,
  isBoroughFilter,
  isFiltered,
  isTypeFilter,
  matchesBorough,
  matchesFilters,
  matchesType,
  normalizeFilters,
  typeOptions,
} from '../src/lib/filters';
import type { Filters } from '../src/lib/filters';
import { DINING_TYPES } from '../src/types/location';
import type { DiningType, LocationProperties } from '../src/types/location';
import { describeType } from '../src/map/style';

function location(overrides: Partial<LocationProperties> = {}): LocationProperties {
  return {
    id: 'eoy-000000000001',
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

const DATA: LocationProperties[] = [
  location({ id: 'eoy-000000000001', type: 'sidewalk', borough: 'Manhattan' }),
  location({ id: 'eoy-000000000002', type: 'sidewalk', borough: 'Brooklyn' }),
  location({ id: 'eoy-000000000003', type: 'roadway', borough: 'Brooklyn' }),
  location({ id: 'eoy-000000000004', type: 'roadway', borough: 'Queens' }),
  location({ id: 'eoy-000000000005', type: 'both', borough: 'Manhattan' }),
  location({ id: 'eoy-000000000006', type: 'both', borough: 'Staten Island' }),
  location({ id: 'eoy-000000000007', type: 'both', borough: 'Bronx' }),
];

describe('filter value guards', () => {
  it('accepts the three types and "all"', () => {
    for (const type of DINING_TYPES) expect(isTypeFilter(type)).toBe(true);
    expect(isTypeFilter('all')).toBe(true);
    expect(isTypeFilter('patio')).toBe(false);
    expect(isTypeFilter('Sidewalk')).toBe(false);
    expect(isTypeFilter(null)).toBe(false);
    expect(isTypeFilter(3)).toBe(false);
  });

  it('accepts the five boroughs and "all"', () => {
    expect(isBoroughFilter('Staten Island')).toBe(true);
    expect(isBoroughFilter('all')).toBe(true);
    expect(isBoroughFilter('New Jersey')).toBe(false);
    expect(isBoroughFilter('staten island')).toBe(false);
    expect(isBoroughFilter(undefined)).toBe(false);
  });
});

describe('normalizeFilters', () => {
  it('passes a valid filter through', () => {
    expect(normalizeFilters({ type: 'both', borough: 'Bronx' })).toEqual({
      type: 'both',
      borough: 'Bronx',
    });
  });

  it('repairs a partially invalid filter field by field', () => {
    expect(normalizeFilters({ type: 'nope', borough: 'Bronx' })).toEqual({
      type: 'all',
      borough: 'Bronx',
    });
    expect(normalizeFilters({ type: 'both', borough: 'nope' })).toEqual({
      type: 'both',
      borough: 'all',
    });
  });

  it('never throws on hostile input', () => {
    for (const input of [undefined, null, 42, 'sidewalk', [], {}, { type: {}, borough: [] }]) {
      expect(normalizeFilters(input)).toEqual(NO_FILTER);
    }
  });
});

describe('matchesType / matchesBorough / matchesFilters', () => {
  it('treats "all" as no constraint', () => {
    expect(matchesType(DATA[0] as LocationProperties, 'all')).toBe(true);
    expect(matchesBorough(DATA[0] as LocationProperties, 'all')).toBe(true);
  });

  it('matches on exact equality, not a prefix', () => {
    expect(matchesType(DATA[0] as LocationProperties, 'sidewalk')).toBe(true);
    expect(matchesType(DATA[0] as LocationProperties, 'roadway')).toBe(false);
    expect(matchesBorough(DATA[0] as LocationProperties, 'Manhattan')).toBe(true);
    // The guard rejects the wrong case, and the predicate would not match it either.
    expect(matchesBorough(DATA[0] as LocationProperties, 'manhattan' as never)).toBe(false);
  });

  it('ANDs the two dimensions', () => {
    const filters: Filters = { type: 'sidewalk', borough: 'Manhattan' };
    expect(matchesFilters(DATA[0] as LocationProperties, filters)).toBe(true);
    expect(matchesFilters(DATA[1] as LocationProperties, filters)).toBe(false);
    expect(matchesFilters(DATA[4] as LocationProperties, filters)).toBe(false);
  });
});

describe('isFiltered', () => {
  it('is false only when both dimensions are "all"', () => {
    expect(isFiltered({ type: 'all', borough: 'all' })).toBe(false);
    expect(isFiltered({ type: 'both', borough: 'all' })).toBe(true);
    expect(isFiltered({ type: 'all', borough: 'Bronx' })).toBe(true);
  });
});

describe('applyFilters', () => {
  it('returns everything for no filter', () => {
    expect(applyFilters(DATA, NO_FILTER)).toHaveLength(DATA.length);
  });

  it('returns a copy, never the caller\'s array', () => {
    const result = applyFilters(DATA, NO_FILTER);
    expect(result).not.toBe(DATA);
    result.push(location({ id: 'eoy-000000000009' }));
    expect(DATA).toHaveLength(7);
  });

  it('filters by type', () => {
    expect(applyFilters(DATA, { type: 'roadway', borough: 'all' }).map((l) => l.id)).toEqual([
      'eoy-000000000003',
      'eoy-000000000004',
    ]);
  });

  it('filters by borough', () => {
    expect(applyFilters(DATA, { type: 'all', borough: 'Manhattan' }).map((l) => l.id)).toEqual([
      'eoy-000000000001',
      'eoy-000000000005',
    ]);
  });

  it('filters by both at once', () => {
    expect(applyFilters(DATA, { type: 'both', borough: 'Bronx' }).map((l) => l.id)).toEqual([
      'eoy-000000000007',
    ]);
  });

  it('returns an empty list rather than throwing when nothing matches', () => {
    expect(applyFilters(DATA, { type: 'roadway', borough: 'Bronx' })).toEqual([]);
  });

  it('handles an empty dataset', () => {
    expect(applyFilters([], { type: 'both', borough: 'all' })).toEqual([]);
  });
});

describe('counts', () => {
  it('counts by type across the whole dataset', () => {
    expect(countByType(DATA)).toEqual({ sidewalk: 2, roadway: 2, both: 3 });
  });

  it('counts by borough and includes a zero for every borough', () => {
    expect(countByBorough(DATA)).toEqual({
      Manhattan: 2,
      Brooklyn: 2,
      Queens: 1,
      Bronx: 1,
      'Staten Island': 1,
    });
  });

  it('reports the count a candidate filter would yield', () => {
    expect(countFor(DATA, NO_FILTER)).toBe(7);
    expect(countFor(DATA, { type: 'both', borough: 'all' })).toBe(3);
    expect(countFor(DATA, { type: 'both', borough: 'Bronx' })).toBe(1);
    expect(countFor(DATA, { type: 'roadway', borough: 'Bronx' })).toBe(0);
  });

  it('counts the other dimension against the active one', () => {
    // With Queens selected, the sidewalk option can only count Manhattan and Brooklyn.
    expect(countFor(DATA, { type: 'sidewalk', borough: 'Queens' })).toBe(0);
  });
});

describe('filter options for the UI', () => {
  it('offers "all" first, then every dining type, labelled from the one vocabulary', () => {
    const options = typeOptions(DATA, NO_FILTER, describeType);
    expect(options.map((option) => option.value)).toEqual(['all', 'sidewalk', 'roadway', 'both']);
    expect(options.map((option) => option.label)).toEqual([
      'All (7)',
      'Sidewalk dining',
      'Roadway dining',
      'Sidewalk + roadway dining',
    ]);
    expect(options.map((option) => option.count)).toEqual([7, 2, 2, 3]);
    expect(options.every((option) => option.empty === false)).toBe(true);
  });

  it('offers every borough after "all"', () => {
    const options = boroughOptions(DATA, NO_FILTER);
    expect(options.map((option) => option.value)).toEqual([
      'all',
      'Manhattan',
      'Brooklyn',
      'Queens',
      'Bronx',
      'Staten Island',
    ]);
    expect(options[0]?.label).toBe('All (7)');
  });

  it('counts options against the other active dimension, and flags the empty ones', () => {
    const options = typeOptions(DATA, { type: 'all', borough: 'Queens' }, describeType);
    expect(options.find((option) => option.value === 'sidewalk')?.count).toBe(0);
    expect(options.find((option) => option.value === 'sidewalk')?.empty).toBe(true);
    expect(options.find((option) => option.value === 'roadway')?.count).toBe(1);
  });

  it('handles an empty dataset without dividing by zero or throwing', () => {
    expect(countByType([])).toEqual({ sidewalk: 0, roadway: 0, both: 0 });
    expect(countFor([], NO_FILTER)).toBe(0);
    expect(typeOptions([], NO_FILTER, describeType).every((option) => option.empty)).toBe(true);
  });

  it('uses a describe callback rather than hard-coding the wording', () => {
    const options = typeOptions(DATA, NO_FILTER, (type: DiningType) => type.toUpperCase());
    expect(options[1]?.label).toBe('SIDEWALK');
  });
});
