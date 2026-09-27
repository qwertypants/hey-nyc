import { describe, expect, it } from 'vitest';
import { MATCH_NONE, MAX_RESULTS, normalizeText, scoreMatch, searchLocations } from '../src/lib/search';
import type { LocationProperties } from '../src/types/location';

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
  location({ id: 'eoy-000000000001', name: 'EMMY', legalName: 'EMH 919 INC' }),
  location({ id: 'eoy-000000000002', name: 'EMPIRE BAR', legalName: 'EMPIRE HOLDINGS' }),
  location({ id: 'eoy-000000000003', name: 'THE EMPIRE', legalName: 'ZZZ 1 LLC' }),
  location({ id: 'eoy-000000000004', name: 'CAFÉ CONDESA', legalName: 'CONDESA LLC' }),
  location({ id: 'eoy-000000000005', name: "JOE'S PIZZA", legalName: 'JOE PIZZA INC' }),
  location({ id: 'eoy-000000000006', name: 'RAMEN NAGI', legalName: 'NAGI NYC LLC' }),
];

describe('normalizeText', () => {
  it('folds case, diacritics, punctuation and whitespace', () => {
    expect(normalizeText('CAFÉ')).toBe('cafe');
    expect(normalizeText('Café')).toBe('cafe');
    expect(normalizeText("JOE'S PIZZA")).toBe('joes pizza');
    expect(normalizeText('  A  B  ')).toBe('a b');
    expect(normalizeText('Ångström')).toBe('angstrom');
    expect(normalizeText('Núñez')).toBe('nunez');
    expect(normalizeText('A&B')).toBe('a b');
  });

  it('handles pre-composed and decomposed forms identically', () => {
    expect(normalizeText('café')).toBe(normalizeText('café'));
  });

  it('returns an empty string for empty or punctuation-only input', () => {
    expect(normalizeText('')).toBe('');
    expect(normalizeText('   ')).toBe('');
    expect(normalizeText('!!!')).toBe('');
  });
});

describe('scoreMatch', () => {
  it('scores an exact field highest', () => {
    expect(scoreMatch('EMMY', 'emmy')).toBeGreaterThan(scoreMatch('EMMY DINER', 'emmy'));
  });

  it('scores a prefix above a word-start above a substring', () => {
    const prefix = scoreMatch('EMPIRE BAR', 'empire');
    const wordStart = scoreMatch('THE EMPIRE', 'empire');
    // Mid-word, not at a word boundary: the weakest tier that is still a match.
    const substring = scoreMatch('SUPEREMPIRE GRILL', 'empire');
    expect(prefix).toBeGreaterThan(wordStart);
    expect(wordStart).toBeGreaterThan(substring);
    expect(substring).toBeGreaterThan(MATCH_NONE);
  });

  it('rejects a non-match', () => {
    expect(scoreMatch('EMMY', 'pizza')).toBe(MATCH_NONE);
  });

  it('is diacritic- and case-insensitive', () => {
    expect(scoreMatch('CAFÉ CONDESA', 'cafe')).toBeGreaterThan(MATCH_NONE);
    expect(scoreMatch('Café Condesa', 'CAFE')).toBeGreaterThan(MATCH_NONE);
  });

  it('requires every term of a multi-word query to match', () => {
    expect(scoreMatch('THE EMPIRE', 'empire the')).toBeGreaterThan(MATCH_NONE);
    expect(scoreMatch('THE EMPIRE', 'empire bar')).toBe(MATCH_NONE);
  });

  it('cannot be improved by adding a term', () => {
    expect(scoreMatch('EMPIRE BAR', 'empire bar')).toBeLessThanOrEqual(
      scoreMatch('EMPIRE BAR', 'empire'),
    );
  });

  it('returns MATCH_NONE for an empty query or candidate', () => {
    expect(scoreMatch('EMMY', '')).toBe(MATCH_NONE);
    expect(scoreMatch('', 'emmy')).toBe(MATCH_NONE);
  });
});

describe('searchLocations', () => {
  it('returns nothing for a blank query', () => {
    expect(searchLocations(DATA, '')).toEqual([]);
    expect(searchLocations(DATA, '    ')).toEqual([]);
  });

  it('ranks prefix above word-start above substring', () => {
    const names = searchLocations(DATA, 'empire').map((item) => item.name);
    expect(names).toEqual(['EMPIRE BAR', 'THE EMPIRE']);
  });

  it('is case-insensitive', () => {
    expect(searchLocations(DATA, 'eMmY').map((item) => item.name)).toEqual(['EMMY']);
    expect(searchLocations(DATA, 'emmy').map((item) => item.name)).toEqual(['EMMY']);
  });

  it('is diacritic-insensitive', () => {
    expect(searchLocations(DATA, 'cafe').map((item) => item.name)).toEqual(['CAFÉ CONDESA']);
    expect(searchLocations(DATA, 'café').map((item) => item.name)).toEqual(['CAFÉ CONDESA']);
  });

  it('deletes apostrophes so "joes" finds "JOE\'S PIZZA"', () => {
    expect(searchLocations(DATA, 'joes').map((item) => item.name)).toEqual(["JOE'S PIZZA"]);
    expect(searchLocations(DATA, "joe's").map((item) => item.name)).toEqual(["JOE'S PIZZA"]);
  });

  it('matches the legal name when the display name does not match', () => {
    expect(searchLocations(DATA, 'nagi').map((item) => item.name)).toEqual(['RAMEN NAGI']);
  });

  it('matches a legal name that no display name contains', () => {
    const results = searchLocations(DATA, 'zzz');
    expect(results.map((item) => item.id)).toEqual(['eoy-000000000003']);
  });

  it('prefers the display name when both match equally', () => {
    const results = searchLocations(DATA, 'emmy');
    expect(results[0]?.name).toBe('EMMY');
  });

  it('returns nothing when there is no match', () => {
    expect(searchLocations(DATA, 'sushi')).toEqual([]);
  });

  it('supports multi-word queries', () => {
    expect(searchLocations(DATA, 'the empire').map((item) => item.name)).toEqual(['THE EMPIRE']);
    expect(searchLocations(DATA, 'empire bar')).toHaveLength(1);
  });

  it('caps the result count', () => {
    const many = Array.from({ length: 200 }, (_, index) =>
      location({ id: `eoy-${index.toString(16).padStart(12, '0')}`, name: `EMPIRE ${index}` }),
    );
    expect(searchLocations(many, 'empire')).toHaveLength(MAX_RESULTS);
    expect(searchLocations(many, 'empire', { limit: 7 })).toHaveLength(7);
  });

  it('ignores a nonsense limit', () => {
    expect(searchLocations(DATA, 'empire', { limit: 0 })).toHaveLength(2);
    expect(searchLocations(DATA, 'empire', { limit: -5 })).toHaveLength(2);
    expect(searchLocations(DATA, 'empire', { limit: Number.NaN })).toHaveLength(2);
  });

  it('is stable across runs, so the list does not reshuffle on re-render', () => {
    const first = searchLocations(DATA, 'empire').map((item) => item.id);
    const second = searchLocations(DATA, 'empire').map((item) => item.id);
    expect(first).toEqual(second);
  });

  it('breaks an exact tie on the id, not on array order', () => {
    const tie: LocationProperties[] = [
      location({ id: 'eoy-0000000000bb', name: 'EMPIRE' }),
      location({ id: 'eoy-0000000000aa', name: 'EMPIRE' }),
    ];
    expect(searchLocations(tie, 'empire').map((item) => item.id)).toEqual([
      'eoy-0000000000aa',
      'eoy-0000000000bb',
    ]);
  });

  it('handles an empty dataset', () => {
    expect(searchLocations([], 'emmy')).toEqual([]);
  });
});
