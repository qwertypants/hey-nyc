/**
 * INTEGRATION NOTES (src/map/extent.ts)
 *
 * The map's visible extent as four numbers. It used to live at the bottom of
 * `src/map/layers.ts`, which held the GeoJSON source, every layer, the filter composition
 * and map interaction; all of that has moved to `src/features/eat/layers.ts`, because a
 * feature owns its own drawing and the controller owns none. What is left here is the one
 * thing that genuinely belongs to the CAMERA rather than to any feature, because it is the
 * camera's visible extent and every feature needs it to answer "what is in this area?".
 *
 * Kept as its own module so `src/map/` holds the camera and the engine binding, and
 * `src/features/` holds everything a feature draws.
 *
 * Public surface:
 *   readBounds(map): MapBounds
 */

import type { Map as MapLibreMap } from 'maplibre-gl';
import type { MapBounds } from '../lib/bounds';

export function readBounds(map: MapLibreMap): MapBounds {
  const bounds = map.getBounds();
  return {
    west: bounds.getWest(),
    south: bounds.getSouth(),
    east: bounds.getEast(),
    north: bounds.getNorth(),
  };
}
