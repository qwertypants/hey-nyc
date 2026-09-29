/**
 * Reduced motion at the camera.
 *
 * Every motion in this app is imperative JavaScript driving the MapLibre camera, and the
 * stylesheet declares no `transition` and no `animation`. So the
 * `@media (prefers-reduced-motion: reduce)` block in `src/index.css` has nothing to switch
 * off: the app honoured the preference for a class of animation it does not have, and ignored
 * it for the one class it does.
 *
 * The seam is `map.easeTo` and `map.fitBounds`, because that is where a move becomes an
 * animation or does not. A reduced-motion camera move still CALLS `easeTo` — MapLibre decides
 * what to do with `duration` and `essential` — so these are assertions on the arguments, not on
 * whether the call happened.
 *
 * `essential` is the half worth reading them for. In MapLibre it does not mean "this is
 * important"; it means "ignore the user's reduced-motion setting"
 * (`node_modules/maplibre-gl/src/ui/camera.ts`, where both `easeTo` and `flyTo` branch on
 * `!options.essential && browser.prefersReducedMotion`). A default of `true` is therefore not a
 * missing feature, it is the app instructing MapLibre to override the user.
 */

import { describe, expect, it, vi } from 'vitest';
import { createMapController } from '../src/map/controller';
import type { MapController } from '../src/map/controller';
import type { CreateMapOptions } from '../src/map/createMap';
import { prefersReducedMotion } from '../src/map/motion';
import { createEatFeature } from '../src/features/eat/eatFeature';
import type { FeatureHandlers } from '../src/features/registry';
import type { MapBounds } from '../src/lib/bounds';
import { FIXTURES, METADATA_FIXTURE, makeCollection } from './helpers/fixtures';
import { indexCollection } from '../src/data/dataset';
import { clusterFeature, createFakeMap } from './helpers/fakeMap';
import type { FakeMap } from './helpers/fakeMap';
import { stubPrefersReducedMotion } from './helpers/reducedMotion';

const { mounted } = vi.hoisted(() => ({ mounted: { current: null as FakeMap | null } }));

// Only the MapLibre constructor is replaced. `createMapController` and every module under it
// are the real ones, so a camera move here is the one the app ships. The callbacks are wired the
// way the real `createMap` wires them — onto the map, not called directly — so `style.load`
// still fires after construction rather than during it.
vi.mock('../src/map/createMap', () => ({
  createMap: (options: CreateMapOptions) => {
    const control = createFakeMap();
    mounted.current = control;
    if (options.onError !== undefined) {
      control.on('error', (event) => {
        const failure = (event as { error: unknown }).error;
        options.onError?.(failure instanceof Error ? failure : new Error(String(failure)));
      });
    }
    if (options.onStyleLoad !== undefined) {
      control.on('style.load', () => options.onStyleLoad?.(control.map));
    }
    return control.map;
  },
}));

/**
 * The Eat Outside feature, built with no React around it.
 *
 * The cluster test below used to be able to lean on the controller for this: the controller
 * owned the layers, so wiring the interactions was part of creating it. It does not any more
 * — a feature owns its own drawing, which is what makes a switch a layer swap — so the test
 * mounts the feature itself, through the same public method the shell calls.
 */
const INDEX = indexCollection(makeCollection(FIXTURES));

const NO_HANDLERS: FeatureHandlers = {
  onSelect: () => undefined,
  onClearSelection: () => undefined,
  onError: () => undefined,
};

function eatFeature() {
  return createEatFeature({
    status: 'ready',
    locations: INDEX.locations,
    byId: INDEX.byId,
    coords: INDEX.coords,
    collection: INDEX.collection,
    metadata: METADATA_FIXTURE,
    error: null,
    retry: () => undefined,
  });
}

const BOUNDS: MapBounds = { west: -74.02, south: 40.7, east: -73.94, north: 40.79 };

const TIMES_SQUARE: [number, number] = [-73.9855, 40.758];

/** A controller whose style has loaded, which is when MapLibre starts accepting camera moves. */
function createController(): { controller: MapController; map: FakeMap } {
  const controller = createMapController({ container: document.createElement('div') });
  const map = mounted.current;
  if (map === null) throw new Error('the map was never created');
  map.loadStyle();
  return { controller, map };
}

/** `expandCluster` resolves `getClusterExpansionZoom` before it moves, so a click is async. */
function settle(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

describe('a camera move still animates when the user has not asked it not to', () => {
  it('flyTo asks for the app duration', () => {
    stubPrefersReducedMotion(false);
    const { controller, map } = createController();

    controller.flyTo({ lng: -73.9875, lat: 40.7223, zoom: 15 });

    expect(map.easeToCalls).toHaveLength(1);
    expect(map.easeToCalls[0]).toMatchObject({ zoom: 15, duration: 480 });
  });

  it('fitTo asks for the app duration', () => {
    stubPrefersReducedMotion(false);
    const { controller, map } = createController();

    controller.fitTo(BOUNDS);

    expect(map.fitBoundsCalls).toHaveLength(1);
    expect(map.fitBoundsCalls[0]?.options).toMatchObject({ duration: 480 });
  });
});

describe('a camera move does not animate when the user has prefers-reduced-motion: reduce', () => {
  it('flyTo asks for no animation', () => {
    stubPrefersReducedMotion(true);
    const { controller, map } = createController();

    controller.flyTo({ lng: -73.9875, lat: 40.7223, zoom: 15 });

    expect(map.easeToCalls).toHaveLength(1);
    expect(map.easeToCalls[0]).toMatchObject({ zoom: 15, duration: 0 });
  });

  it('flyTo does not let essential override the preference', () => {
    // `essential: true` is MapLibre's word for "override the user's setting", so honouring it
    // here would make the whole preference advisory. The camera still lands on the same place;
    // it just does not travel there.
    stubPrefersReducedMotion(true);
    const { controller, map } = createController();

    controller.flyTo({ lng: -73.9875, lat: 40.7223, zoom: 15 }, { essential: true });

    expect(map.easeToCalls[0]).toMatchObject({ duration: 0, essential: false });
  });

  it('fitTo asks for no animation, on either path MapLibre can take it through', () => {
    // `fitBounds` routes to `flyTo` by default and to `easeTo` when `linear` is set, and those
    // two take the preference by different routes. Neither may animate.
    stubPrefersReducedMotion(true);
    const { controller, map } = createController();

    controller.fitTo(BOUNDS);

    expect(map.fitBoundsCalls[0]?.options).toMatchObject({ duration: 0, essential: false });
  });

  it('fitToResults reaches the same conclusion, because it moves the camera too', () => {
    stubPrefersReducedMotion(true);
    const { controller, map } = createController();

    // The extent is computed by the feature, for the same reason `focusOn` takes a position:
    // the controller has no dataset.
    controller.fitToResults(BOUNDS);

    expect(map.fitBoundsCalls).toHaveLength(1);
    expect(map.fitBoundsCalls[0]?.options).toMatchObject({ duration: 0, essential: false });
  });

  it('fitToResults to nothing moves nothing, rather than to a degenerate box', () => {
    stubPrefersReducedMotion(true);
    const { controller, map } = createController();

    controller.fitToResults(null);

    expect(map.fitBoundsCalls).toHaveLength(0);
  });

  it('selecting a location from the list does not animate', () => {
    stubPrefersReducedMotion(true);
    const { controller, map } = createController();

    expect(controller.focusOn('eoy-0000000000a1', { lat: 40.7223, lng: -73.9875 })).toBe(true);

    expect(map.easeToCalls[0]).toMatchObject({ duration: 0, essential: false });
  });

  it('focusOn an id the active feature does not have does nothing at all', () => {
    stubPrefersReducedMotion(false);
    const { controller, map } = createController();

    // This is the switch case: an id belonging to the other feature cannot be flown to.
    expect(controller.focusOn('wsh-0000000000a1', null)).toBe(false);
    expect(map.easeToCalls).toHaveLength(0);
  });

  it('expanding a cluster does not animate, even though it is a frame away in another module', async () => {
    stubPrefersReducedMotion(true);
    const { map } = createController();
    const feature = eatFeature();
    feature.state.setHandlers(NO_HANDLERS);
    // A feature mounted BY HAND, and handed the map with no cast. It used to read
    // `map.map as unknown as MapLibreLike` — the same widening `useActiveFeature` needed,
    // for the same reason, because `MapLibreLike.on` was monomorphic and MapLibre's is an
    // overload set. The seam is a supertype of the engine now, so a test that mounts a
    // feature by hand is the second place the two meet and it needs nothing.
    feature.mount(map.map);
    map.setRenderedFeatures([clusterFeature(7, TIMES_SQUARE)]);

    map.fire('click', { point: [10, 10] });
    await settle();

    expect(map.easeToCalls).toHaveLength(1);
    expect(map.easeToCalls[0]).toMatchObject({ center: TIMES_SQUARE, zoom: 14, duration: 0 });
    expect(map.easeToCalls[0]).toMatchObject({ essential: false });
  });
});

describe('the preference is read per move, not once per page', () => {
  it('a visitor who turns reduced motion on in the OS gets it on the next camera move', () => {
    // A module-level constant would be evaluated before either stub is installed, and would
    // then freeze the answer for the life of the page.
    stubPrefersReducedMotion(false);
    const { controller, map } = createController();

    controller.flyTo({ lng: -73.9875, lat: 40.7223, zoom: 15 });
    expect(map.easeToCalls[0]).toMatchObject({ duration: 480 });

    stubPrefersReducedMotion(true);
    controller.flyTo({ lng: -73.9875, lat: 40.7223, zoom: 15 });
    expect(map.easeToCalls[1]).toMatchObject({ duration: 0 });
  });

  it('an environment with no matchMedia reports motion allowed rather than throwing', () => {
    // A server render and a jsdom run without the setup stub both land here.
    vi.stubGlobal('matchMedia', undefined);

    expect(prefersReducedMotion()).toBe(false);
  });
});
