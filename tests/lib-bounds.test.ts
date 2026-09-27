import { describe, expect, it } from 'vitest';
import {
  EMPTY_BOUNDS,
  boundsAreValid,
  boundsContain,
  formatBounds,
  unionBounds,
} from '../src/lib/bounds';
import type { MapBounds } from '../src/lib/bounds';

const MANHATTAN: MapBounds = { west: -74.02, south: 40.69, east: -73.93, north: 40.88 };

describe('boundsContain', () => {
  it('includes points on the edge, because a marker on the boundary is visible', () => {
    expect(boundsContain(MANHATTAN, 40.69, -74.02)).toBe(true);
    expect(boundsContain(MANHATTAN, 40.88, -73.93)).toBe(true);
  });

  it('excludes points outside the viewport', () => {
    expect(boundsContain(MANHATTAN, 40.5, -73.99)).toBe(false);
    expect(boundsContain(MANHATTAN, 40.7, -74.5)).toBe(false);
  });

  it('treats a missing bounds as "no bounds filter", never as "nothing matches"', () => {
    expect(boundsContain(null, 40.7, -73.99)).toBe(true);
    expect(boundsContain(undefined, 40.7, -73.99)).toBe(true);
  });

  it('accepts every point against EMPTY_BOUNDS', () => {
    expect(boundsContain(EMPTY_BOUNDS, 40.7, -73.99)).toBe(true);
    expect(boundsContain(EMPTY_BOUNDS, 0, 0)).toBe(true);
  });

  it('rejects non-finite coordinates rather than returning a wrong answer', () => {
    expect(boundsContain(MANHATTAN, Number.NaN, -73.99)).toBe(false);
    expect(boundsContain(MANHATTAN, 40.7, Number.POSITIVE_INFINITY)).toBe(false);
  });
});

describe('boundsAreValid', () => {
  it('requires a non-degenerate rectangle', () => {
    expect(boundsAreValid(MANHATTAN)).toBe(true);
    expect(boundsAreValid({ west: 1, south: 1, east: 1, north: 2 })).toBe(false);
    expect(boundsAreValid({ west: 1, south: 2, east: 2, north: 1 })).toBe(false);
  });

  it('rejects inverted, empty and non-finite bounds', () => {
    expect(boundsAreValid(null)).toBe(false);
    expect(boundsAreValid({ west: Number.NaN, south: 0, east: 1, north: 2 })).toBe(false);
    expect(boundsAreValid({ west: 0, south: 0, east: Number.POSITIVE_INFINITY, north: 2 })).toBe(
      false,
    );
  });
});

describe('unionBounds', () => {
  it('takes the outer envelope', () => {
    expect(unionBounds(MANHATTAN, { west: -74.1, south: 40.6, east: -73.9, north: 40.9 })).toEqual({
      west: -74.1,
      south: 40.6,
      east: -73.9,
      north: 40.9,
    });
  });

  it('is commutative', () => {
    const other = { west: -74.1, south: 40.6, east: -73.9, north: 40.9 };
    expect(unionBounds(MANHATTAN, other)).toEqual(unionBounds(other, MANHATTAN));
  });
});

describe('formatBounds', () => {
  it('renders a stable, rounded label', () => {
    expect(formatBounds(MANHATTAN)).toBe('40.690, -74.020 to 40.880, -73.930');
  });
});
