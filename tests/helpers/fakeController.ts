/**
 * A `MapController` that behaves like the real one without a WebGL context.
 *
 * jsdom cannot construct MapLibre, so every component test drives this instead. The point of
 * making it faithful rather than a stub is that the app's integration contract is the
 * thing under test: `focusOn` selects AND flies, `setSelectedId` only highlights, `getState`
 * is referentially stable between changes, and `bounds` arrives asynchronously. A loose mock
 * would let a regression in any of those pass.
 *
 * So this mirrors the real implementation's observable behaviour, records every call for
 * assertions, and exposes the three things only the map can do — become ready, report a new
 * extent, and report a feature click.
 *
 * Public surface:
 *   FakeController, FakeControllerCalls
 *   createFakeController(options?): FakeController
 */

import { vi } from 'vitest';
import type {
  CreateMapControllerOptions,
  MapController,
  MapControllerState,
  MapStatus,
} from '../../src/map/controller';
import type { MapBounds } from '../../src/lib/bounds';
import type { Filters } from '../../src/lib/filters';
import type { MapView } from '../../src/lib/urlState';
import { DEFAULT_VIEW, clampView } from '../../src/lib/urlState';
// `LABEL_STYLE.minZoom`, not `FOCUS_ZOOM` from `src/map/controller.ts`: the latter imports
// MapLibre for its value, and this helper is imported by tests that must never reach the map
// engine. They are the same number — `FOCUS_ZOOM` is defined as exactly this.
import { LABEL_STYLE } from '../../src/map/style';
import { MIDTOWN_BOUNDS } from './fixtures';

export interface FakeControllerCalls {
  readonly setFilters: ReturnType<typeof vi.fn>;
  readonly setSelectedId: ReturnType<typeof vi.fn>;
  readonly focusOn: ReturnType<typeof vi.fn>;
  readonly flyTo: ReturnType<typeof vi.fn>;
  readonly fitTo: ReturnType<typeof vi.fn>;
  readonly fitToResults: ReturnType<typeof vi.fn>;
  readonly resize: ReturnType<typeof vi.fn>;
  readonly destroy: ReturnType<typeof vi.fn>;
}

export interface FakeController extends MapController {
  /** Everything the app called, for assertions. */
  readonly calls: FakeControllerCalls;
  /** What the controller was constructed with, so initial-URL wiring can be asserted. */
  readonly initial: CreateMapControllerOptions;
  /** Style load finished. Fires the initial `bounds` + `view` publish, like the real one. */
  ready(bounds?: MapBounds): void;
  /** Surfaces a MapLibre error. */
  fail(error: Error): void;
  /** A pan or zoom: new extent, new camera, no selection change. */
  setBounds(bounds: MapBounds, view?: Partial<MapView>): void;
  /** A tap on a pin. The real map calls `setSelectedId`, never `focusOn`. */
  selectFromMap(id: string | null): void;
  /** True once `destroy()` has run. */
  readonly isDestroyed: () => boolean;
}

export interface CreateFakeControllerOptions {
  /** Start in `loading` (style not yet loaded). Defaults to ready. */
  readonly autoReady?: boolean;
  /** Initial visible extent. Defaults to the Midtown box. */
  readonly bounds?: MapBounds;
}

export function createFakeController(
  options: CreateMapControllerOptions,
  settings: CreateFakeControllerOptions = {},
): FakeController {
  const { autoReady = true } = settings;
  const listeners = new Set<() => void>();
  let destroyed = false;
  let readyResolve: (controller: MapController) => void = () => undefined;
  const ready = new Promise<MapController>((resolve) => {
    readyResolve = resolve;
  });

  let state: MapControllerState = {
    status: 'loading',
    view: clampView(options.initialView ?? DEFAULT_VIEW),
    filters: options.initialFilters ?? { type: 'all', borough: 'all' },
    selectedId: options.initialSelectedId ?? null,
    bounds: null,
    error: null,
  };

  const calls = {
    setFilters: vi.fn(),
    setSelectedId: vi.fn(),
    focusOn: vi.fn(),
    flyTo: vi.fn(),
    fitTo: vi.fn(),
    fitToResults: vi.fn(),
    resize: vi.fn(),
    destroy: vi.fn(),
  } satisfies FakeControllerCalls;

  function publish(next: Partial<MapControllerState>): void {
    state = { ...state, ...next };
    for (const listener of listeners) listener();
  }

  function setSelectedId(id: string | null): void {
    calls.setSelectedId(id);
    if (destroyed) return;
    publish({ selectedId: id });
  }

  function setFilters(filters: Filters): void {
    calls.setFilters(filters);
    if (destroyed) return;
    publish({ filters });
  }

  function flyTo(view: Partial<MapView>): void {
    calls.flyTo(view);
    if (destroyed) return;
    publish({ view: clampView({ ...state.view, ...view }) });
  }

  const controller: FakeController = {
    calls,
    initial: options,

    whenReady: () => ready,
    getMap: () => null,
    getState: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    setFilters,
    setSelectedId,

    focusOn(id: string) {
      calls.focusOn(id);
      if (destroyed) return false;
      if (!options.dataset.coords.has(id)) return false;
      setSelectedId(id);
      // Mirrors src/map/controller.ts: FOCUS_ZOOM at least, the map's maxZoom at most.
      flyTo({ zoom: Math.min(Math.max(state.view.zoom, LABEL_STYLE.minZoom), 16) });
      return true;
    },

    flyTo,

    fitTo(bounds: MapBounds) {
      calls.fitTo(bounds);
    },

    fitToResults() {
      calls.fitToResults();
    },

    getBounds: () => state.bounds,

    resize() {
      calls.resize();
    },

    destroy() {
      calls.destroy();
      destroyed = true;
      listeners.clear();
    },

    isDestroyed: () => destroyed,

    ready(bounds?: MapBounds) {
      if (destroyed) return;
      publish({
        status: 'ready' as MapStatus,
        bounds: bounds ?? settings.bounds ?? MIDTOWN_BOUNDS,
        error: null,
      });
      readyResolve(controller);
    },

    fail(error: Error) {
      if (destroyed) return;
      publish({ status: 'error', error });
    },

    setBounds(bounds: MapBounds, view?: Partial<MapView>) {
      if (destroyed) return;
      publish(
        view === undefined ? { bounds } : { bounds, view: clampView({ ...state.view, ...view }) },
      );
    },

    selectFromMap(id: string | null) {
      setSelectedId(id);
    },
  };

  if (autoReady) controller.ready();

  return controller;
}
