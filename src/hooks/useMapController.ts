/**
 * Owns the ONE map controller and exposes its state to React.
 *
 * The controller is created in an effect, not during render, because it needs a real
 * container element and a loaded dataset. It is torn down on unmount and whenever the
 * dataset identity changes (which only happens on a retry), so a MapLibre instance and its
 * WebGL context never outlive the data they draw.
 *
 * State arrives through `useSyncExternalStore` — the exact shape `MapController` was built
 * for — so a camera move re-renders the list without putting a single camera value in React
 * state. While there is no controller (dataset still loading, or a retry in flight) a single
 * frozen `MapControllerState` is returned, which keeps the snapshot referentially stable and
 * keeps `useMemo` dependencies downstream from churning.
 *
 * WHY `create` IS REQUIRED. This module imports `MapController` as a TYPE ONLY and never
 * imports `createMapController` as a value. MapLibre runs `URL.createObjectURL` at module
 * scope, so merely importing it needs a browser with object URLs — and a UI layer that
 * cannot be rendered without a WebGL engine cannot be tested honestly. Making the factory a
 * required prop puts the single engine-binding line in `main.tsx`, where it belongs, and
 * leaves the entire component tree free of the map engine. The cost is one required prop; the
 * benefit is that `tests/helpers/fakeController.ts` can drive the real app.
 *
 * Public surface:
 *   type MapControllerFactory, type UseMapControllerOptions, type UseMapControllerResult
 *   EMPTY_MAP_STATE, useMapController(options): UseMapControllerResult
 */

import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type {
  CreateMapControllerOptions,
  MapController,
  MapControllerState,
} from '../map/controller';
import type { LoadedDataset } from '../data/load';
import type { Filters } from '../lib/filters';
import type { MapView } from '../lib/urlState';
import { DEFAULT_VIEW } from '../lib/urlState';

export type MapControllerFactory = (options: CreateMapControllerOptions) => MapController;

export const EMPTY_MAP_STATE: MapControllerState = {
  status: 'loading',
  view: DEFAULT_VIEW,
  filters: { type: 'all', borough: 'all' },
  selectedId: null,
  bounds: null,
  error: null,
};

function subscribeToNothing(): () => void {
  return () => undefined;
}

function getEmptyState(): MapControllerState {
  return EMPTY_MAP_STATE;
}

export interface UseMapControllerOptions {
  /** The element the map mounts into. Null until React has committed it. */
  readonly container: HTMLElement | null;
  /** Null until the dataset resolves; the controller is not created without it. */
  readonly dataset: LoadedDataset | null;
  readonly initialView: MapView;
  readonly initialFilters: Filters;
  readonly initialSelectedId: string | null;
  readonly create: MapControllerFactory;
}

export interface UseMapControllerResult {
  readonly controller: MapController | null;
  readonly state: MapControllerState;
}

export function useMapController(
  options: UseMapControllerOptions,
): UseMapControllerResult {
  const { container, dataset, initialView, initialFilters, initialSelectedId, create } = options;

  const [controller, setController] = useState<MapController | null>(null);
  // Read through a ref so a caller passing an inline arrow does not destroy and rebuild the
  // map on every render.
  const createRef = useRef(create);
  createRef.current = create;

  const initialRef = useRef({ initialView, initialFilters, initialSelectedId });
  initialRef.current = { initialView, initialFilters, initialSelectedId };

  useEffect(() => {
    if (container === null || dataset === null) return;

    const { initialView: view, initialFilters: filters, initialSelectedId: selected } =
      initialRef.current;
    const created = createRef.current({
      container,
      dataset,
      initialView: view,
      initialFilters: filters,
      initialSelectedId: selected,
    });

    setController(created);

    return () => {
      created.destroy();
    };
  }, [container, dataset]);

  const state = useSyncExternalStore(
    controller === null ? subscribeToNothing : controller.subscribe,
    controller === null ? getEmptyState : controller.getState,
    controller === null ? getEmptyState : controller.getState,
  );

  return { controller, state };
}
