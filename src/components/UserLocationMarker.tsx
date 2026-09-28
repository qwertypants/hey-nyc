/**
 * The georeferenced user-position dot, drawn by MapLibre rather than by us.
 *
 * `MapController` deliberately does not own a geolocation layer — "the app does not own a
 * visitor's position" is a policy, not an implementation gap — but it does expose
 * `getMap()` as an escape hatch, and a `Marker` is the one thing that needs the map
 * instance itself. This is that escape hatch, in one small file, so nothing else in the UI
 * layer touches MapLibre.
 *
 * WHY THE DYNAMIC `import()`. MapLibre runs `URL.createObjectURL` at module scope, so a
 * static import of it makes every module that transitively reaches the map engine
 * unloadable in jsdom. Importing it here, inside the effect, keeps `maplibre-gl` out of the
 * UI layer's static graph entirely: the component tree stays renderable without a WebGL
 * engine, and the engine is only pulled in on a real device that has already built a map.
 *
 * `vite build` prints a warning that this dynamic import "will not move module into another
 * chunk" because `src/map/createMap.ts` also imports MapLibre statically. That warning is
 * expected and the outcome is exactly what is wanted: MapLibre stays in its own chunk, and
 * the UI bundle stays free of it. Do not "fix" it by making this a static import — that
 * would put the engine back in the component graph and make the app untestable in jsdom.
 *
 * It is a DOM marker, not a layer, because there is at most ONE of it and it must survive a
 * style change. The effect only runs when a map actually exists, so in jsdom — where the
 * fake controller returns `getMap() === null` — this does nothing at all.
 *
 * The accessible, non-georeferenced companion is the `.eoy-user-chip` in the app chrome.
 * A dot at a pixel coordinate is useless to a screen reader; a chip that says "Using your
 * location" and offers "Turn off" is not.
 *
 * Public surface:
 *   UserLocationMarker(props): null
 */

import type { JSX } from 'react';
import { useEffect } from 'react';
import type { MapController } from '../map/controller';
import type { LatLng } from '../lib/distance';

export interface UserLocationMarkerProps {
  readonly controller: MapController | null;
  readonly position: LatLng | null;
}

export function UserLocationMarker({ controller, position }: UserLocationMarkerProps): JSX.Element | null {
  useEffect(() => {
    if (controller === null || position === null) return;
    const map = controller.getMap();
    if (map === null) return;

    let cancelled = false;
    let marker: { remove: () => void } | null = null;

    void import('maplibre-gl').then(({ Marker }) => {
      if (cancelled) return;
      try {
        const element = document.createElement('div');
        element.className = 'eoy-user-marker';
        // WHY `aria-hidden`. MapLibre parents this node into `.eoy-map`, which App.tsx
        // marks up as a `role="region"` with a name — so "invisible to a screen reader" is
        // no longer something the DOM gives us for free. An empty div happens to be inert,
        // but that is an accident of there being no text, role or name in it, not a promise:
        // the first person to drop a label in here publishes it. The attribute makes the
        // intent enforced rather than inferred. The counterpart is the chip named in the
        // header above; nothing here is worth reading out.
        element.setAttribute('aria-hidden', 'true');
        marker = new Marker({ element, anchor: 'center' })
          .setLngLat([position.lng, position.lat])
          .addTo(map);
      } catch {
        // A marker is an enhancement. If MapLibre refuses it, the map and the chip still work.
      }
    });

    return () => {
      cancelled = true;
      marker?.remove();
      marker = null;
    };
  }, [controller, position]);

  return null;
}
