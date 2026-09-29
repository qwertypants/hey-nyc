/**
 * The user-position dot: the one node in the app built by hand and then parented into a
 * `role="region"` by MapLibre, which is the only place accessibility and the map engine
 * touch the same element.
 *
 * WHY THIS IS ITS OWN FILE rather than another `it` in `app-geolocation.test.tsx`.
 * `vi.mock('maplibre-gl', …)` is per-file and applies to the whole module graph, so folding
 * this in would swap MapLibre out from under every test in that file. And it is not the same
 * assertion: that file already covers the chip, which is the accessible half. What is
 * covered nowhere is the other half — that the element handed to the `Marker` opts out of
 * the accessibility tree.
 *
 * WHAT IS FAKED, AND WHY THERE IS NO CHEAPER SEAM. jsdom has no WebGL, so
 * `tests/helpers/fakeController.ts` returns `getMap() === null`, which is the branch where the
 * component correctly does nothing at all — the branch every other test in this suite is
 * stuck on, and the reason this element is invisible from `app-geolocation.test.tsx`. So the
 * controller's `getMap` is overridden with an opaque stub (the component only ever forwards
 * it to `addTo`), and `maplibre-gl` is mocked so the dynamic `import()` inside the effect
 * resolves to a `Marker` that records what it was handed. Both fakes sit on seams the
 * component's own header comment already says exist; neither replaces the effect, so the
 * code that builds the element is the code under test.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, waitFor } from '@testing-library/react';
import type { Map as MapLibreMap } from 'maplibre-gl';
import { UserLocationMarker } from '../src/components/UserLocationMarker';
import type { LatLng } from '../src/lib/distance';
import type { MapController } from '../src/map/controller';
import { createFakeController } from './helpers/fakeController';

const POSITION: LatLng = { lat: 40.758, lng: -73.9855 };

/** What the fake `Marker` records. The three members the component actually drives. */
interface MarkerSpy {
  readonly element: HTMLElement;
  lngLat: [number, number] | null;
  removed: boolean;
}

// `vi.mock` factories are hoisted above the imports, so the recorder has to be hoisted with
// them; `vi.hoisted` is the supported way to share state into a mock factory.
const { markers } = vi.hoisted(() => ({ markers: [] as MarkerSpy[] }));

vi.mock('maplibre-gl', () => {
  class FakeMarker implements MarkerSpy {
    readonly element: HTMLElement;
    lngLat: [number, number] | null = null;
    removed = false;

    constructor(options: { element: HTMLElement }) {
      this.element = options.element;
      markers.push(this);
    }

    setLngLat(lngLat: [number, number]): this {
      this.lngLat = lngLat;
      return this;
    }

    // `addTo` is the last link in the chain, and the map is opaque to the component, so
    // there is nothing here to record.
    addTo(): this {
      return this;
    }

    remove(): void {
      this.removed = true;
    }
  }

  return { Marker: FakeMarker };
});

/**
 * Opaque to the component, which only forwards it to `addTo`. The cast is the same escape
 * `tests/helpers/render.tsx` uses for the geolocation doubles: with no WebGL there is no way
 * to construct the real class, and nothing in this file reads a member of it.
 */
const MAP = { id: 'fake-map' } as unknown as MapLibreMap;

function controllerReporting(map: MapLibreMap | null): MapController {
  // The real fake controller again for everything else, so this is still a faithful
  // `MapController` and not a one-method stand-in wearing its type.
  const controller = createFakeController({ container: document.createElement('div') });
  return { ...controller, getMap: () => map };
}

describe('the user-position dot', () => {
  beforeEach(() => {
    markers.length = 0;
  });

  it('is built only once a map exists, and is hidden from assistive technology when it is', async () => {
    render(<UserLocationMarker controller={controllerReporting(MAP)} position={POSITION} />);
    await waitFor(() => {
      expect(markers).toHaveLength(1);
    });

    // The element MapLibre was handed, asserted directly. It is never appended to the
    // document here — the fake `Marker` does not parent it — so reading it off the captured
    // node is the only way to see what the component actually built.
    expect(markers[0]?.element.className).toBe('eoy-user-marker');
    expect(markers[0]?.element.getAttribute('aria-hidden')).toBe('true');
    // Also positioned, so the two assertions above are about a live marker rather than a
    // half-built one.
    expect(markers[0]?.lngLat).toEqual([POSITION.lng, POSITION.lat]);

    // The same component against a controller reporting no map. Deliberately second: by now
    // the import has resolved and is cached, so a marker that should not exist cannot hide
    // behind an unresolved module the way it could before the first `waitFor`. This is the
    // state jsdom is permanently in, and it is why no other test in the suite sees the dot.
    render(<UserLocationMarker controller={controllerReporting(null)} position={POSITION} />);
    await act(async () => {});
    expect(markers).toHaveLength(1);
  });
});
