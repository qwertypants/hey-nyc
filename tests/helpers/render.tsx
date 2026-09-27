/**
 * `navigator.geolocation` doubles, and the app's render harness.
 *
 * On the "only Near Me asks" requirement: the assertions run against a spy object handed to
 * the app, so `getCurrentPosition` is counted directly. A test that merely stubbed
 * `navigator` could be satisfied by a hook that never reads it; counting the calls cannot.
 * `stubNavigatorGeolocation` exists for the test that must exercise the real `navigator`
 * read inside `useGeolocation`.
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
  readonly bounds: typeof MIDTOWN_BOUNDS;
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

  const createController = (createOptions: Parameters<NonNullable<AppProps['createController']>>[0]) => {
    created = createFakeController(createOptions, {
      autoReady: options.mapPending !== true,
      bounds: MIDTOWN_BOUNDS,
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
  };
}
