import { describe, expect, it } from 'vitest';
import { fitViewFor, fitZoom, NYC_DATA_BOUNDS } from '../src/lib/viewport';
import { VIEW_LIMITS } from '../src/lib/urlState';

const PHONE = { width: 390, height: 704 };
const TABLET = { width: 820, height: 1024 };
const DESKTOP = { width: 1440, height: 900 };
const LANDSCAPE_PHONE = { width: 844, height: 390 };

function mercatorY(lat: number): number {
  const rad = (lat * Math.PI) / 180;
  return (1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2;
}

function mercatorLat(y: number): number {
  return (Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * 180) / Math.PI;
}

/** The four edges of the visible frame, in degrees. */
function frameEdges(
  view: { lng: number; lat: number },
  width: number,
  height: number,
  worldPx: number,
): { west: number; east: number; south: number; north: number } {
  const y = mercatorY(view.lat);
  const dy = height / 2 / worldPx;
  return {
    west: view.lng - (width / 2 / worldPx) * 360,
    east: view.lng + (width / 2 / worldPx) * 360,
    south: mercatorLat(y + dy),
    north: mercatorLat(y - dy),
  };
}

describe('fitZoom', () => {
  it('frames the bounds at every viewport, so nothing is cut off', () => {
    const EPS = 1e-9;
    for (const vp of [PHONE, TABLET, DESKTOP, LANDSCAPE_PHONE]) {
      const z = fitZoom(NYC_DATA_BOUNDS, vp.width, vp.height, 32);
      const worldPx = 256 * 2 ** z;
      const visibleLng = (vp.width - 64) / worldPx * 360;
      const visibleLatY = (vp.height - 64) / worldPx;
      const span = NYC_DATA_BOUNDS.east - NYC_DATA_BOUNDS.west;
      expect(visibleLng + EPS, `lng fits at ${vp.width}px`).toBeGreaterThanOrEqual(span);
      expect(visibleLatY).toBeGreaterThan(0);
    }
  });

  it('is monotonic: a wider viewport zooms in further', () => {
    const narrow = fitZoom(NYC_DATA_BOUNDS, PHONE.width, PHONE.height, 32);
    const wide = fitZoom(NYC_DATA_BOUNDS, DESKTOP.width, DESKTOP.height, 32);
    expect(wide).toBeGreaterThan(narrow);
  });

  it('tolerates degenerate and hostile viewports without NaN', () => {
    for (const vp of [
      { width: 0, height: 0 },
      { width: -500, height: -500 },
      { width: Number.NaN, height: Number.NaN },
      { width: Number.POSITIVE_INFINITY, height: 10 },
    ]) {
      const z = fitViewFor(NYC_DATA_BOUNDS, vp.width, vp.height);
      expect(Number.isFinite(z.zoom)).toBe(true);
      expect(Number.isFinite(z.lat)).toBe(true);
      expect(Number.isFinite(z.lng)).toBe(true);
    }
  });
});

describe('fitViewFor', () => {
  it('centres on the data, not on the boroughs', () => {
    const view = fitViewFor(NYC_DATA_BOUNDS, DESKTOP.width, DESKTOP.height);
    expect(view.lng).toBeCloseTo(-73.93185, 4);
    expect(view.lat).toBeCloseTo(40.74205, 4);
  });

  it('puts every borough that has data inside the opening frame on a phone', () => {
    const view = fitViewFor(NYC_DATA_BOUNDS, PHONE.width, PHONE.height);
    const worldPx = 256 * 2 ** view.zoom;
    const westEdge = view.lng - (PHONE.width / 2 / worldPx) * 360;
    const eastEdge = view.lng + (PHONE.width / 2 / worldPx) * 360;
    // Staten Island's westernmost published location, and Queens' easternmost.
    expect(westEdge).toBeLessThanOrEqual(NYC_DATA_BOUNDS.west);
    expect(eastEdge).toBeGreaterThanOrEqual(NYC_DATA_BOUNDS.east);
  });

  it('frames the DATA extent, not the borough bounding box', () => {
    // The original bug was a fixed centre/zoom tuned on a laptop: at 390px it ran
    // lng -74.142..-73.788, which cut off the northern Bronx and eastern Queens — three of
    // five boroughs were off screen. New Jersey's waterfront is genuinely that close to
    // Manhattan, so some NJ in frame is geography, not a defect. What must be true is that
    // the frame is sized to the DATA, not to the boroughs (whose box reaches -74.257).
    const view = fitViewFor(NYC_DATA_BOUNDS, PHONE.width, PHONE.height);
    const worldPx = 256 * 2 ** view.zoom;
    const frameLngSpan = (PHONE.width / worldPx) * 360;
    const dataSpan = NYC_DATA_BOUNDS.east - NYC_DATA_BOUNDS.west;
    expect(frameLngSpan / dataSpan).toBeLessThan(1.3);
    // The borough box would need 1.49x; a tight fit needs 1.0x.
    expect(frameLngSpan / dataSpan).toBeGreaterThan(1.0);
  });

  it('keeps the northern Bronx and eastern Queens on screen on a phone', () => {
    const view = fitViewFor(NYC_DATA_BOUNDS, PHONE.width, PHONE.height);
    const worldPx = 256 * 2 ** view.zoom;
    const { west, east, north, south } = frameEdges(view, PHONE.width, PHONE.height, worldPx);
    // Northern Bronx, and Queens' Rockaway peninsula — the two extents the old fixed
    // centre/zoom pushed off screen.
    expect(north).toBeGreaterThan(40.88);
    expect(south).toBeLessThan(40.6);
    expect(east).toBeGreaterThan(-73.75);
    expect(west).toBeLessThanOrEqual(-74.05);
  });

  it('applies the zoom floor so a huge viewport does not over-zoom', () => {
    const view = fitViewFor(NYC_DATA_BOUNDS, 3840, 2160);
    expect(view.zoom).toBeLessThanOrEqual(11.6);
  });

  it('stays inside the app camera limits everywhere', () => {
    for (const vp of [PHONE, TABLET, DESKTOP, LANDSCAPE_PHONE, { width: 1, height: 1 }]) {
      const { lng, lat, zoom } = fitViewFor(NYC_DATA_BOUNDS, vp.width, vp.height);
      expect(lng).toBeGreaterThanOrEqual(VIEW_LIMITS.minLng);
      expect(lng).toBeLessThanOrEqual(VIEW_LIMITS.maxLng);
      expect(lat).toBeGreaterThanOrEqual(VIEW_LIMITS.minLat);
      expect(lat).toBeLessThanOrEqual(VIEW_LIMITS.maxLat);
      expect(zoom).toBeGreaterThanOrEqual(VIEW_LIMITS.minZoom);
      expect(zoom).toBeLessThanOrEqual(VIEW_LIMITS.maxZoom);
    }
  });

  it('honours a larger padding by zooming out', () => {
    // The zoom floor must not bind here, or it would mask the padding effect.
    const opts = { maxZoomFloor: 16 };
    const tight = fitViewFor(NYC_DATA_BOUNDS, PHONE.width, PHONE.height, { ...opts, paddingPx: 0 });
    const padded = fitViewFor(NYC_DATA_BOUNDS, PHONE.width, PHONE.height, { ...opts, paddingPx: 120 });
    expect(padded.zoom).toBeLessThan(tight.zoom);
  });
});
