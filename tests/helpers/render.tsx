/**
 * `navigator.geolocation` doubles, and the app's render harness.
 *
 * On the "only Near Me asks" requirement: the assertions run against a spy object handed to
 * the app, so `getCurrentPosition` is counted directly. A test that merely stubbed
 * `navigator` could be satisfied by a hook that never reads it; counting the calls cannot.
 * `stubNavigatorGeolocation` exists for the test that must exercise the real `navigator`
 * read inside `useGeolocation`.
 *
 * The `withMap` opt-in and the `createCount` accessor are here for
 * `tests/feature-switching.test.tsx`: a feature is only mounted when the controller hands it
 * a map, and the only way to count what a feature put on that map is to give the fake
 * controller a `FakeMap` to hand over.
 *
 * Public surface:
 *   GeolocationBehaviour, GeolocationDouble
 *   makeGeolocation(behaviour, position?), stubNavigatorGeolocation,
 *   restoreNavigatorGeolocation, TimesSquareLocation
 *   geocodeHit, RenderAppOptions, RenderAppResult
 *   renderApp(options?): RenderAppResult
 */

import type { ReactElement } from 'react';
import { render } from '@testing-library/react';
import type { RenderResult } from '@testing-library/react';
import { App } from '../../src/App';
import type { AppProps } from '../../src/App';
import type { GeocodeOutcome, GeocodeResult } from '../../src/lib/geocode';
import { activateDatasetFetch } from './datasetFetch';
import type { DatasetFetchControl, DatasetFetchOptions } from './datasetFetch';
import { createFakeController } from './fakeController';
import type { FakeController } from './fakeController';
import type { LatLng } from '../../src/lib/distance';
import type { MapBounds } from '../../src/lib/bounds';
import { FIXTURES, METADATA_FIXTURE, MIDTOWN_BOUNDS, makeCollection } from './fixtures';

export type GeolocationBehaviour = 'granted' | 'denied' | 'unavailable' | 'timeout' | 'error';

export const TimesSquareLocation: LatLng = { lat: 40.758, lng: -73.9855 };

function positionError(code: number, message: string): GeolocationPositionError {
  return {
    code,
    message,
    PERMISSION_DENIED: 1,
    POSITION_UNAVAILABLE: 2,
    TIMEOUT: 3,
  } as unknown as GeolocationPositionError;
}

function position(latLng: LatLng): GeolocationPosition {
  return {
    coords: {
      latitude: latLng.lat,
      longitude: latLng.lng,
      accuracy: 8,
      altitude: null,
      altitudeAccuracy: null,
      heading: null,
      speed: null,
    },
    timestamp: 1_757_000_000_000,
  } as unknown as GeolocationPosition;
}

export interface GeolocationDouble extends Geolocation {
  /** How many times `getCurrentPosition` was actually called. */
  readonly callCount: () => number;
}

export function makeGeolocation(
  behaviour: GeolocationBehaviour,
  latLng: LatLng = TimesSquareLocation,
): GeolocationDouble {
  let calls = 0;
  return {
    callCount: () => calls,
    getCurrentPosition(success, error) {
      calls += 1;
      switch (behaviour) {
        case 'granted':
          success(position(latLng));
          return;
        case 'denied':
          error?.(positionError(1, 'User denied Geolocation'));
          return;
        case 'unavailable':
          error?.(positionError(2, 'Position unavailable'));
          return;
        case 'timeout':
          error?.(positionError(3, 'Timeout expired'));
          return;
        case 'error':
          error?.(positionError(-1, 'Unknown failure'));
      }
    },
    watchPosition: () => 0,
    clearWatch: () => undefined,
  } as GeolocationDouble;
}

export function stubNavigatorGeolocation(value: Geolocation | null): void {
  Object.defineProperty(globalThis.navigator, 'geolocation', {
    configurable: true,
    writable: true,
    value,
  });
}

export function restoreNavigatorGeolocation(): void {
  Reflect.deleteProperty(globalThis.navigator, 'geolocation');
}

export function geocodeHit(overrides: Partial<GeocodeResult> = {}): GeocodeOutcome {
  const result: GeocodeResult = {
    placeId: '12345',
    label: 'Bryant Park, New York, New York, USA',
    lat: 40.7536,
    lng: -73.9832,
    kind: 'park',
    importance: 0.8,
    ...overrides,
  };
  return { status: 'ok', results: [result] };
}

export interface RenderAppOptions {
  /** Initial query string, e.g. `'?type=roadway'`. Defaults to a clean slate. */
  readonly search?: string;
  readonly dataset?: DatasetFetchOptions;
  /** Leaves the map in its `loading` state so the basemap-loading chip can be asserted. */
  readonly mapPending?: boolean;
  /**
   * Give the fake controller a real `FakeMap`, so a feature is actually mounted on it and
   * its layers, sources and listeners can be counted. Off by default; see
   * `tests/helpers/fakeController.ts` for why turning it on everywhere is not free.
   */
  readonly withMap?: boolean;
  /**
   * The extent the fake map reports. Defaults to `MIDTOWN_BOUNDS`, which contains three of
   * the Eat Outside fixtures and NONE of the walk ones — so a test that switches to Where
   * NYC Walks and then wants to see its list has to hand it an extent the walk fixtures are
   * actually inside. That is a property of the fixtures, not a bug, and changing the default
   * would quietly move the list assertions in `tests/app-map-list.test.tsx`.
   */
  readonly bounds?: MapBounds;
  readonly geolocation?: Geolocation | null;
  /** Replaces the geocoder. Defaults to a "no results" answer, so no test hits a network. */
  readonly geocode?: (query: string) => Promise<GeocodeOutcome>;
  readonly app?: Partial<AppProps>;
}

export interface RenderAppResult extends RenderResult {
  /** The fake controller the app created. Throws if it never did. */
  readonly controller: () => FakeController;
  readonly dataset: DatasetFetchControl;
  /** Queries the app actually sent to the geocoder. */
  readonly geocodeCalls: () => string[];
  readonly bounds: MapBounds;
  /**
   * How many times the app called the controller factory. One map per container is the whole
   * point of the feature switch, and this is the number that says so: a switch that rebuilt
   * the map would push it past one.
   */
  readonly createCount: () => number;
}

export function renderApp(options: RenderAppOptions = {}): RenderAppResult {
  window.history.replaceState(null, '', options.search ?? '/');

  const dataset = activateDatasetFetch({
    collection: makeCollection(FIXTURES),
    metadata: METADATA_FIXTURE,
    ...options.dataset,
  });

  const geocodeQueries: string[] = [];
  const geocode = async (query: string): Promise<GeocodeOutcome> => {
    geocodeQueries.push(query);
    if (options.geocode !== undefined) return options.geocode(query);
    return { status: 'empty', query };
  };

  let created: FakeController | null = null;
  let createCount = 0;

  const createController = (
    createOptions: Parameters<NonNullable<AppProps['createController']>>[0],
  ) => {
    createCount += 1;
    created = createFakeController(createOptions, {
      autoReady: options.mapPending !== true,
      bounds: options.bounds ?? MIDTOWN_BOUNDS,
      withMap: options.withMap === true,
    });
    return created;
  };

  const props: AppProps = {
    createController,
    urlDelayMs: 0,
    geocode,
    ...(options.geolocation === undefined ? {} : { geolocation: options.geolocation }),
    ...(options.app ?? {}),
  };

  const element: ReactElement = <App {...props} />;
  const result = render(element);

  return {
    ...result,
    controller: () => {
      if (created === null) throw new Error('the map controller was never created');
      return created;
    },
    dataset,
    geocodeCalls: () => geocodeQueries,
    bounds: MIDTOWN_BOUNDS,
    createCount: () => createCount,
  };
}
