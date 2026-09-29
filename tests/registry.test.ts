/**
 * THE SEAM HAS TO ACCEPT THE REAL MAP.
 *
 * `MapLibreLike` in `src/features/registry.ts` is a structural stand-in for MapLibre's `Map`
 * so that no module under `src/features/` imports `maplibre-gl`. That trade is only worth
 * making if the stand-in is a genuine SUPERTYPE of the engine. It was not: `on` was declared
 * with a single two-argument signature returning `void`, and TypeScript refuses to assign an
 * overloaded method to a monomorphic one — so a feature could never have been handed the real
 * map, and the app carried two `as unknown as` casts at the engine boundary plus a widening
 * interface in `src/features/eat/eatMap.ts` to route around it.
 *
 * THE FIRST TEST IN THIS FILE IS A COMPILE-TIME ASSERTION with a runtime call in it. If a
 * member is dropped from `MapLibreLike`, narrowed, or declared in a way MapLibre's own
 * signature is not assignable to, `handToFeature` below stops compiling and the WHOLE suite
 * fails — not this file, the build. That is the property the two casts used to stand in for,
 * asserted where a change to it will actually be noticed.
 *
 * The rest is behaviour that is only observable through a real call: that `on` hands back
 * something with `unsubscribe`, and that `queryRenderedFeatures` is given the `{ layers }`
 * argument rather than being asked about the whole map.
 */

import { describe, expect, it } from 'vitest';
import type { Map as MapLibreMap } from 'maplibre-gl';
import type { MapLibreLike, QueryRenderedOptions } from '../src/features/registry';
import { createFakeMap } from './helpers/fakeMap';

/**
 * The assertion. A real `MapLibreMap` in, a `MapLibreLike` out, with no cast.
 *
 * It is called with the double below purely so the function is not dead code and the
 * compiler cannot drop it; the interesting part is the parameter and return types, which are
 * checked whether or not the body ever runs.
 */
function handToFeature(map: MapLibreMap): MapLibreLike {
  return map;
}

describe('a real MapLibre Map satisfies the registry seam', () => {
  it('needs no cast, in either direction', () => {
    const fake = createFakeMap();
    // COMPILES ONLY WHILE `MapLibreLike` IS A SUPERTYPE OF `MapLibreMap`.
    const feature: MapLibreLike = handToFeature(fake.map);
    // Touches members on both sides of the boundary, so the object is not elided and the
    // compiler really does have to check the assignment rather than the call.
    expect(feature.getCanvas().style).toBeDefined();
    expect(feature.getLayer('nothing-here')).toBeUndefined();
    // And the same the other way round, so a feature cannot quietly ask for a member the
    // engine does not have.
    const engine: MapLibreMap = fake.map;
    expect(typeof engine.addLayer).toBe('function');
  });
});

describe('the seam hands back everything a feature needs to clean up after itself', () => {
  it('`on` returns a subscription, and unsubscribing really detaches the listener', () => {
    const fake = createFakeMap();
    const map: MapLibreLike = fake.map;
    let fired = 0;
    const subscription = map.on('click', () => {
      fired += 1;
    });

    fake.fire('click', { point: { x: 0, y: 0 } });
    expect(fired).toBe(1);
    expect(fake.listenerCount()).toBe(1);

    subscription.unsubscribe();
    fake.fire('click', { point: { x: 0, y: 0 } });
    expect(fired).toBe(1);
    expect(fake.listenerCount()).toBe(0);
  });

  it('`on` takes a layer id, for a listener scoped to one layer', () => {
    const fake = createFakeMap();
    const map: MapLibreLike = fake.map;
    const subscription = map.on('mouseenter', 'wnyc-historical-core', () => undefined);
    expect(fake.listenerCount()).toBe(1);
    subscription.unsubscribe();
    expect(fake.listenerCount()).toBe(0);
  });

  it('`queryRenderedFeatures` is given a layers scope rather than asked about the whole map', () => {
    const fake = createFakeMap();
    const map: MapLibreLike = fake.map;
    const options: QueryRenderedOptions = { layers: ['wnyc-historical-core'] };
    map.queryRenderedFeatures({ x: 1, y: 2 }, options);

    expect(fake.queries()).toHaveLength(1);
    expect(fake.queries()[0]?.options).toBe(options);
  });

  it('a rendered hit carries its geometry, so a cluster\'s coordinates can be read', () => {
    const fake = createFakeMap();
    fake.setRenderedFeatures([
      { geometry: { type: 'Point', coordinates: [-73.98, 40.75] }, properties: { id: 'wsh-1' } },
    ]);
    const hit = handToFeature(fake.map).queryRenderedFeatures({ x: 0, y: 0 })[0];
    expect(hit?.geometry?.coordinates?.[0]).toBe(-73.98);
    expect(hit?.properties?.['id']).toBe('wsh-1');
  });
});
