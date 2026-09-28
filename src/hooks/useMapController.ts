/**
 * Owns the ONE map controller and exposes its state to React.
 *
 * The controller is created in an effect, not during render, because it needs a real
 * container element. It is torn down on unmount and whenever the container changes, so a
 * MapLibre instance and its WebGL context never outlive the element they draw into.
 *
 * The effect's dependency list is `[container, enabled]` and NOTHING ELSE — deliberately. It
 * used to be `[container, dataset]`, which meant a dataset reload destroyed and rebuilt the
 * map, and which would now mean the same thing every time the visitor switched feature. The
 * map outlives both: what is on it is chosen by `useActiveFeature`, which mounts a feature's
 * layers onto the existing instance and unmounts them again. `enabled` is a gate on CREATION
 * and never on teardown — see the two effects below, which exist separately for that reason.
 *
 * State arrives through `useSyncExternalStore` — the exact shape `MapController` was built
 * for — so a camera move re-renders the list without putting a single camera value in React
 * state. While there is no controller a single frozen `MapControllerState` is returned,
 * which keeps the snapshot referentially stable and keeps `useMemo` dependencies downstream
 * from churning.
 *
 * WHY `create` IS REQUIRED. This module imports `MapController` as a TYPE ONLY and never
 * imports `createMapController` as a value. MapLibre runs `URL.createObjectURL` at module
 * scope, so merely importing it needs a browser with object URLs — and a UI layer that
 * cannot be rendered without a WebGL engine cannot be tested honestly. Making the factory a
 * required prop puts the single engine-binding line in `main.tsx`, where it belongs, and
 * leaves the entire component tree free of the map engine. The cost is one required prop;
 * the benefit is that `tests/helpers/fakeController.ts` can drive the real app.
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
  /**
   * False until the ACTIVE FEATURE's data has resolved, which is when the map has something
   * to draw. This is what used to be `dataset: LoadedDataset | null` and it is the same rule
   * with a smaller type: the controller no longer needs the dataset, but the shell still owes
   * it one map rather than several, and it must not be built before there is a feature to put
   * on it.
   *
   * It is also what keeps the controller's `filters` and `selectedId` honest. Those are seeded
   * from the shared link at construction, so a controller created before the feature can
   * honour them would publish a filter the rail shows as absent and a selection nothing can
   * resolve — a map that claims to be filtered by something the visitor cannot see.
   */
  readonly enabled: boolean;
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
  const { container, enabled, initialView, initialFilters, initialSelectedId, create } = options;

  const [controller, setController] = useState<MapController | null>(null);
  // Read through a ref so a caller passing an inline arrow does not destroy and rebuild the
  // map on every render.
  const createRef = useRef(create);
  createRef.current = create;

  // Read through a ref, and NOT in the dependency list: a shared link is read once and never
  // re-read, so a change here must not rebuild the map. `createMapController` has already
  // applied them to the controller's initial state by the time this runs.
  const initialRef = useRef({ initialView, initialFilters, initialSelectedId });
  initialRef.current = { initialView, initialFilters, initialSelectedId };

  /*
   * THE CONTROLLER IS CREATED ONCE.
   *
   * Two effects, deliberately, because "create it when there is something to draw" and
   * "destroy it when the container goes" are different lifetimes and putting both in one
   * effect gets the teardown wrong. `enabled` flips every time the visitor picks a feature
   * whose data has not arrived yet, and with the gate in the dependency list that reads as
   * "the map is no longer wanted" — so a single click on the switcher destroyed the map and
   * built a second WebGL context. Which is the exact failure this whole refactor exists to
   * prevent, arrived at from the other direction.
   *
   * So: the first effect CREATES, once, guarded by a ref rather than by a dependency; the
   * second DESTROYS, and only when the container is replaced or the app unmounts. A later
   * `enabled` is a reason to have built one already, never a reason to tear one down.
   */
  const createdRef = useRef<MapController | null>(null);

  useEffect(() => {
    if (container === null || !enabled || createdRef.current !== null) return;

    const { initialView: view, initialFilters: filters, initialSelectedId: selected } =
      initialRef.current;
    const created = createRef.current({
      container,
      initialView: view,
      initialFilters: filters,
      initialSelectedId: selected,
    });

    createdRef.current = created;
    setController(created);
  }, [container, enabled]);

  useEffect(
    () => () => {
      createdRef.current?.destroy();
      createdRef.current = null;
    },
    [container],
  );

  const state = useSyncExternalStore(
    controller === null ? subscribeToNothing : controller.subscribe,
    controller === null ? getEmptyState : controller.getState,
    controller === null ? getEmptyState : controller.getState,
  );

  return { controller, state };
}
