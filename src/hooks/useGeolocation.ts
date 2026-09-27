/**
 * The ONLY place the app asks the browser where the visitor is.
 *
 * `request()` is the only function that touches `navigator.geolocation`, and it is called
 * from exactly one place: an explicit tap on "Near me". Nothing runs on mount, on search,
 * on filter change, or on a shared-link load. That is a product requirement, not an
 * implementation detail — a map that silently starts asking for your position is a map you
 * cannot trust — and `tests/app-geolocation.test.tsx` asserts it.
 *
 * Every failure mode is a short sentence the UI can render inline. There is no modal, no
 * retry storm, and no dead end: the map, the list and the search all keep working.
 *
 * The fix is deliberately NOT persisted. It lives in React state, is never written to the
 * URL (`serializeUrlState` has no key for it — see src/lib/urlState.ts) and is dropped the
 * moment the visitor taps "Turn off" or leaves the page.
 *
 * Public surface:
 *   type GeolocationStatus
 *   type GeolocationState
 *   useGeolocation(options?): GeolocationState
 */

import { useCallback, useRef, useState } from 'react';
import type { LatLng } from '../lib/distance';

export type GeolocationStatus =
  | 'idle'
  | 'locating'
  | 'ready'
  /** PERMISSION_DENIED. */
  | 'denied'
  /** No geolocation in this browser, or the position could not be determined. */
  | 'unavailable'
  | 'timeout'
  | 'error';

const DENIED_MESSAGE =
  'Location permission was declined, so the map is not centred on you. Search for an area or browse the list.';
const UNAVAILABLE_MESSAGE =
  'This device will not share your location, so the map is not centred on you. Search for an area or browse the list.';
const TIMEOUT_MESSAGE =
  'Finding your location took too long. Search for an area or browse the list.';
const ERROR_MESSAGE =
  'Your location could not be determined. Search for an area or browse the list.';

const TIMEOUT_MS = 10_000;
/** A fresh-enough fix is fine; re-locating for a few metres of drift is not worth a prompt. */
const MAXIMUM_AGE_MS = 60_000;

export interface GeolocationState {
  readonly status: GeolocationStatus;
  /** The fix, or null. Ephemeral and never serialised. */
  readonly position: LatLng | null;
  /** Non-blocking, user-facing. Null when there is nothing worth saying. */
  readonly message: string | null;
  /** The only path to `getCurrentPosition`. Called from the Near Me button. */
  request: () => void;
  /** Drops the fix and the message. */
  clear: () => void;
}

export interface UseGeolocationOptions {
  /** Injected in tests. Defaults to `navigator.geolocation` read at call time. */
  readonly geolocation?: Geolocation | null;
}

interface InternalState {
  readonly status: GeolocationStatus;
  readonly position: LatLng | null;
  readonly message: string | null;
}

const IDLE: InternalState = { status: 'idle', position: null, message: null };

function messageFor(error: GeolocationPositionError): {
  status: GeolocationStatus;
  message: string;
} {
  switch (error.code) {
    case 1:
      return { status: 'denied', message: DENIED_MESSAGE };
    case 2:
      return { status: 'unavailable', message: UNAVAILABLE_MESSAGE };
    case 3:
      return { status: 'timeout', message: TIMEOUT_MESSAGE };
    default:
      return { status: 'error', message: ERROR_MESSAGE };
  }
}

export function useGeolocation(options: UseGeolocationOptions = {}): GeolocationState {
  const [state, setState] = useState<InternalState>(IDLE);
  // A late success callback must not resurrect a fix after "Turn off" or after unmount.
  const requestRef = useRef(0);

  const request = useCallback((): void => {
    requestRef.current += 1;
    const ticket = requestRef.current;

    const geolocation =
      options.geolocation !== undefined
        ? options.geolocation
        : readNavigatorGeolocation();

    if (geolocation === null) {
      setState({ status: 'unavailable', position: null, message: UNAVAILABLE_MESSAGE });
      return;
    }

    setState({ status: 'locating', position: null, message: null });

    geolocation.getCurrentPosition(
      (position) => {
        if (requestRef.current !== ticket) return;
        const lat = position.coords.latitude;
        const lng = position.coords.longitude;
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
          setState({ status: 'unavailable', position: null, message: UNAVAILABLE_MESSAGE });
          return;
        }
        setState({ status: 'ready', position: { lat, lng }, message: null });
      },
      (error) => {
        if (requestRef.current !== ticket) return;
        const { status, message } = messageFor(error);
        setState({ status, position: null, message });
      },
      { enableHighAccuracy: true, timeout: TIMEOUT_MS, maximumAge: MAXIMUM_AGE_MS },
    );
  }, [options.geolocation]);

  const clear = useCallback((): void => {
    // Bumping the ticket makes any in-flight callback a no-op.
    requestRef.current += 1;
    setState(IDLE);
  }, []);

  return {
    status: state.status,
    position: state.position,
    message: state.message,
    request,
    clear,
  };
}

/**
 * Read at CALL time, not at module load, so a browser that has no geolocation — and a test
 * that installs one after import — both behave the way they should.
 */
function readNavigatorGeolocation(): Geolocation | null {
  if (typeof navigator === 'undefined') return null;
  const candidate = navigator.geolocation;
  if (candidate === undefined || typeof candidate?.getCurrentPosition !== 'function') return null;
  return candidate;
}
