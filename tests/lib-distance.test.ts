import { describe, expect, it } from 'vitest';
import {
  FEET_THRESHOLD_MILES,
  describeDistance,
  distanceMiles,
  formatDistance,
  haversineMiles,
} from '../src/lib/distance';
import type { LatLng } from '../src/lib/distance';

/** Real NYC coordinates, so a regression shows up as a wrong map, not a wrong constant. */
const FLATIRON: LatLng = { lat: 40.7411, lng: -73.9897 };
const COLUMBUS_CIRCLE: LatLng = { lat: 40.7681, lng: -73.9819 };
const TIMES_SQUARE: LatLng = { lat: 40.758, lng: -73.9855 };
const JFK_AIRPORT: LatLng = { lat: 40.6413, lng: -73.7781 };

describe('haversineMiles', () => {
  it('returns exactly zero for the same point', () => {
    expect(haversineMiles(FLATIRON, FLATIRON)).toBe(0);
  });

  it('is symmetric', () => {
    expect(haversineMiles(FLATIRON, COLUMBUS_CIRCLE)).toBeCloseTo(
      haversineMiles(COLUMBUS_CIRCLE, FLATIRON),
      12,
    );
  });

  it('matches the known length of one degree of longitude at the equator', () => {
    // 2*pi*R/360 with R = 3958.7613 mi.
    expect(haversineMiles({ lat: 0, lng: 0 }, { lat: 0, lng: 1 })).toBeCloseTo(69.0934, 3);
  });

  it('matches the known length of one degree of latitude', () => {
    // A degree of latitude is ~69.05 mi everywhere, unlike longitude.
    expect(haversineMiles({ lat: 0, lng: 0 }, { lat: 1, lng: 0 })).toBeCloseTo(69.0934, 2);
  });

  it('scales down one degree of longitude with the cosine of latitude', () => {
    const atEquator = haversineMiles({ lat: 0, lng: 0 }, { lat: 0, lng: 1 });
    const at40 = haversineMiles({ lat: 40.7, lng: -73.9 }, { lat: 40.7, lng: -73.9 + 1 });
    expect(at40 / atEquator).toBeCloseTo(Math.cos((40.7 * Math.PI) / 180), 4);
  });

  it('gets known NYC pairs right', () => {
    // Flatiron -> Columbus Circle is about 1.9 mi as the crow flies.
    expect(haversineMiles(FLATIRON, COLUMBUS_CIRCLE)).toBeGreaterThan(1.85);
    expect(haversineMiles(FLATIRON, COLUMBUS_CIRCLE)).toBeLessThan(1.95);

    // Flatiron -> Times Square is about 1.2 mi.
    expect(haversineMiles(FLATIRON, TIMES_SQUARE)).toBeGreaterThan(1.15);
    expect(haversineMiles(FLATIRON, TIMES_SQUARE)).toBeLessThan(1.3);

    // Times Square -> JFK is about 13.5 mi as the crow flies (drive time is far longer).
    expect(haversineMiles(TIMES_SQUARE, JFK_AIRPORT)).toBeGreaterThan(13);
    expect(haversineMiles(TIMES_SQUARE, JFK_AIRPORT)).toBeLessThan(14);
  });

  it('handles an antipodal pair without producing NaN', () => {
    const antipodal = haversineMiles({ lat: 0, lng: 0 }, { lat: 0, lng: 180 });
    expect(Number.isFinite(antipodal)).toBe(true);
    expect(antipodal).toBeCloseTo(Math.PI * 3958.7613, 3);
  });
});

describe('distanceMiles', () => {
  it('returns null when there is no reference point, so the UI omits the distance', () => {
    expect(distanceMiles(null, FLATIRON)).toBeNull();
    expect(distanceMiles(undefined, FLATIRON)).toBeNull();
  });

  it('returns null rather than inventing a centre-based origin', () => {
    expect(distanceMiles(null, COLUMBUS_CIRCLE)).toBeNull();
  });

  it('returns null for non-finite coordinates instead of NaN', () => {
    expect(distanceMiles({ lat: Number.NaN, lng: -73.9 }, FLATIRON)).toBeNull();
    expect(distanceMiles(FLATIRON, { lat: 40.7, lng: Number.POSITIVE_INFINITY })).toBeNull();
  });

  it('measures when a reference point exists', () => {
    const miles = distanceMiles(FLATIRON, COLUMBUS_CIRCLE);
    expect(miles).toBeCloseTo(haversineMiles(FLATIRON, COLUMBUS_CIRCLE), 12);
  });
});

describe('formatDistance', () => {
  it('passes a missing distance straight through', () => {
    expect(formatDistance(null)).toBeNull();
    expect(formatDistance(undefined)).toBeNull();
  });

  it('rejects non-finite and negative input instead of printing nonsense', () => {
    expect(formatDistance(Number.NaN)).toBeNull();
    expect(formatDistance(Number.POSITIVE_INFINITY)).toBeNull();
    expect(formatDistance(-1)).toBeNull();
  });

  it('switches to feet below 0.1 mi and to miles at or above it', () => {
    expect(formatDistance(0)).toBe('0 ft');
    expect(formatDistance(0.01)).toBe('50 ft');
    expect(formatDistance(0.05)).toBe('260 ft');
    expect(formatDistance(0.09)).toBe('480 ft');
    expect(formatDistance(FEET_THRESHOLD_MILES - Number.EPSILON)).not.toBeNull();
    expect(formatDistance(FEET_THRESHOLD_MILES)).toBe('0.1 mi');
  });

  it('rounds feet to the nearest 10', () => {
    // 0.0333 mi = 175.8 ft -> 180 ft
    expect(formatDistance(0.0333)).toBe('180 ft');
  });

  it('always shows one decimal place in miles', () => {
    expect(formatDistance(1)).toBe('1.0 mi');
    expect(formatDistance(1.25)).toBe('1.3 mi');
    expect(formatDistance(2)).toBe('2.0 mi');
    expect(formatDistance(9.05)).toBe('9.1 mi');
  });

  it('never prints a feet value for a genuinely long distance', () => {
    expect(formatDistance(0.5)).toBe('0.5 mi');
    expect(formatDistance(12.345)).toBe('12.3 mi');
  });
});

describe('describeDistance', () => {
  it('composes the two steps and still returns null with no origin', () => {
    expect(describeDistance(null, FLATIRON)).toBeNull();
    expect(describeDistance(FLATIRON, FLATIRON)).toBe('0 ft');
    expect(describeDistance(TIMES_SQUARE, JFK_AIRPORT)).toMatch(/^\d+\.\d mi$/);
  });

  it('reports feet for a neighbouring storefront', () => {
    // 0.00005 deg of latitude is 0.0035 mi, about 18 ft.
    expect(describeDistance(FLATIRON, { lat: 40.74115, lng: -73.9897 })).toBe('20 ft');
  });
});
