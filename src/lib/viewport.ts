/*
 *   fitViewFor, fitZoom, NYC_DATA_BOUNDS, Bounds
 *
 * The opening frame of a map-first app is the product. A hardcoded
 * centre/zoom cannot be right: NYC is 0.42° wide and 0.34° tall, a phone in
 * portrait is roughly 1:1.8, and New Jersey sits directly west across the
 * Hudson inside NYC's own longitude span. A single constant tuned on a laptop
 * therefore either letterboxes the city on a phone or fills the frame with
 * New Jersey. This module computes the view instead of guessing it.
 *
 * Pure, no MapLibre, no React — unit tested.
 */

import type { MapView } from './urlState';
import { VIEW_LIMITS, MAX_ZOOM, MIN_ZOOM } from './urlState';

export interface Bounds {
  readonly west: number;
  readonly south: number;
  readonly east: number;
  readonly north: number;
}

/**
 * The published dataset's own extent, measured 2026-09-27 across all 2 000
 * features. Framing this rather than the borough boundaries is deliberate: it
 * frames the subject of the map. The borough bounding box reaches
 * -74.257 (Staten Island's west tip), which drags Hoboken, Union City and
 * Jersey City into the opening frame on a narrow viewport.
 */
export const NYC_DATA_BOUNDS: Bounds = {
  west: -74.1437,
  south: 40.5736,
  east: -73.72,
  north: 40.9105,
};

const TILE_SIZE = 256;

/** Web Mercator: project latitude to normalised Mercator y in [0, 1]. */
function mercatorY(lat: number): number {
  const clamped = Math.max(-85.05112878, Math.min(85.05112878, lat));
  const rad = (clamped * Math.PI) / 180;
  return (1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2;
}

/**
 * The zoom at which `bounds` fits inside a `width` x `height` CSS-pixel
 * viewport. Uses the fractional-zoom definition MapLibre uses at fractional
 * `transform.zoom`, so a `fitBounds` result and this agree.
 */
export function fitZoom(
  bounds: Bounds,
  width: number,
  height: number,
  paddingPx = 0,
): number {
  const usableWidth = Math.max(1, width - paddingPx * 2);
  const usableHeight = Math.max(1, height - paddingPx * 2);

  const lonSpan = Math.max(1e-9, bounds.east - bounds.west);
  // A zero-height span would divide by zero; mercatorY clamps latitude first.
  const mercatorSpan = Math.max(1e-12, Math.abs(mercatorY(bounds.south) - mercatorY(bounds.north)));

  // At zoom z the whole world is TILE_SIZE * 2^z px wide, and 360° spans that.
  const zoomForWidth = Math.log2((360 * usableWidth) / (TILE_SIZE * lonSpan));
  const zoomForHeight = Math.log2((360 * usableHeight) / (TILE_SIZE * mercatorSpan));
  return Math.min(zoomForWidth, zoomForHeight);
}

/**
 * A view that frames `bounds`, clamped to the app's camera limits.
 *
 * On a portrait phone the longitude span is the binding constraint, so the
 * result shows the full width of the data and letterboxes vertically. That is
 * the honest trade: every borough with data stays on screen, and the count in
 * the bottom bar plus the list cover the rest. `maxZoomFloor` stops a very
 * large viewport from zooming so far in that the city no longer reads as a
 * city.
 */
export function fitViewFor(
  bounds: Bounds = NYC_DATA_BOUNDS,
  width: number,
  height: number,
  options: { readonly paddingPx?: number; readonly maxZoomFloor?: number } = {},
): MapView {
  const { paddingPx = 32, maxZoomFloor = 11.6 } = options;
  const safeWidth = Number.isFinite(width) && width > 0 ? width : 390;
  const safeHeight = Number.isFinite(height) && height > 0 ? height : 704;

  const lng = (bounds.west + bounds.east) / 2;
  const lat = (bounds.south + bounds.north) / 2;
  const zoom = Math.min(maxZoomFloor, fitZoom(bounds, safeWidth, safeHeight, paddingPx));

  return {
    lng: Math.min(VIEW_LIMITS.maxLng, Math.max(VIEW_LIMITS.minLng, lng)),
    lat: Math.min(VIEW_LIMITS.maxLat, Math.max(VIEW_LIMITS.minLat, lat)),
    zoom: Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom)),
  };
}
