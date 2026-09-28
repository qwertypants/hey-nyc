/**
 * THE SWITCH.
 *
 * Everything that has to be true the instant the visitor changes feature, in one effect and
 * one cleanup, so the four properties can be read off each other:
 *
 *   1. THE MAP IS NOT REBUILT. This hook never creates or destroys a MapLibre instance. It
 *      takes the one the controller holds and hands it to the incoming feature, and hands it
 *      back to the outgoing one on the way out. The controller's own teardown is keyed on the
 *      CONTAINER (`useMapController`), and the container does not change when a feature does.
 *      `tests/feature-switching.test.tsx` asserts the container node, the factory call count
 *      and the layer count across `eat -> walk -> eat -> walk`.
 *
 *   2. THE FEATURE IS TORN DOWN COMPLETELY. The cleanup calls `unmount`, which is the
 *      feature's promise to remove every layer and every listener it added. If it did not,
 *      the layer count would grow by one set per switch, and a click on the map would be
 *      handled by two features at once.
 *
 *   3. THE VIEWPORT IS PRESERVED. The shell does not move the camera on a switch; it passes
 *      the current view to `onEnter` and lets the feature decline. "When reasonable" is the
 *      shell's judgement, because only the shell knows whether a camera is meaningful over a
 *      dataset it cannot see.
 *
 *   4. AN INCOMPATIBLE SELECTION IS CLEARED, NOT RENDERED. An id belongs to exactly one
 *      feature. If the incoming feature cannot `detail()` it, the selection is a leftover, so
 *      the shell clears it through the controller — which closes the sheet, drops the
 *      highlight, and removes `sel=` from the URL. A stale id that happens to exist in the
 *      new feature is not stale, and is kept: both features are keyed by their own id
 *      prefixes, so a collision would be a bug in a pipeline, not something to guard against
 *      by clearing a valid selection.
 *
 * The effect's dependency list is `[controller, mapStatus, feature]` and nothing else. Live
 * state (filters, selection) is applied by two earlier effects and by the mount body itself,
 * so a filter change does not re-run the mount and a switch does not depend on having read
 * a ref at the right moment.
 *
 * Public surface:
 *   type UseActiveFeatureOptions, useActiveFeature(options): void
 */

import { useEffect, useRef } from 'react';
import type { MapController, MapStatus } from '../../map/controller';
import type { Filters } from '../../lib/filters';
import type { AnyFeature, MapLibreLike } from '../registry';

export interface UseActiveFeatureOptions {
  readonly controller: MapController | null;
  /**
   * The controller's map status. `'ready'` is the first moment a feature may draw —
   * `addLayer` before a style exists throws — so this is the gate, and it is the only gate.
   */
  readonly mapStatus: MapStatus;
  readonly feature: AnyFeature;
  /** The active feature's filters, from the controller's mirror. */
  readonly filters: Filters;
  /** The active feature's selection, from the controller's mirror. */
  readonly selectedId: string | null;
  readonly onSelect: (id: string) => void;
  readonly onClearSelection: () => void;
  readonly onError: (error: Error) => void;
}

export function useActiveFeature(options: UseActiveFeatureOptions): void {
  const {
    controller,
    mapStatus,
    feature,
    filters,
    selectedId,
    onSelect,
    onClearSelection,
    onError,
  } = options;

  /**
   * The feature currently ON the map, and the map it is on. Read by the two live-state
   * effects below, which run BEFORE the mount effect on any commit so that a filter change
   * reaches a feature that is already mounted rather than the one that is about to be.
   */
  const mounted = useRef<{ readonly feature: AnyFeature; readonly map: MapLibreLike } | null>(null);

  // The newest of everything the mount body needs, read at the moment it runs rather than
  // captured: a ref updated during render is the only way to give an effect a value without
  // listing it as a dependency and re-running the mount.
  const latest = useRef({ filters, selectedId, onSelect, onClearSelection, onError });
  latest.current = { filters, selectedId, onSelect, onClearSelection, onError };

  useEffect(() => {
    mounted.current?.feature.state.setFilters(filters);
  }, [filters, feature]);

  useEffect(() => {
    mounted.current?.feature.state.setSelectedId(selectedId);
  }, [selectedId, feature]);

  useEffect(() => {
    if (controller === null) return;
    const engineMap = controller.getMap();
    if (engineMap === null || mapStatus !== 'ready') return;

    /*
     * THE ONE PLACE A REAL MAP MEETS THE SEAM, and it needs no cast.
     *
     * This used to read `engineMap as unknown as MapLibreLike`, because `MapLibreLike.on`
     * was monomorphic and TypeScript refuses to assign MapLibre's overload set to it — so
     * the cast was the only way the registry could ever see the real map. `registry.ts` now
     * declares `on` as an overload set returning a `Subscription`, and `queryRenderedFeatures`
     * as taking its `{ layers }` options, which is what MapLibre's own signatures are. So
     * the assignment below is a compile-time proof that a `MapLibreMap` satisfies the seam,
     * and `tests/registry.test.ts` asserts the same fact independently of this hook.
     */
    const map: MapLibreLike = engineMap;

    const current = latest.current;
    feature.state.setHandlers({
      onSelect: current.onSelect,
      onClearSelection: current.onClearSelection,
      onError: current.onError,
    });
    feature.mount(map);
    // Pushed explicitly as well as through the effects above, because on the commit that
    // MOUNTS there has been no previous mount for those effects to find.
    feature.state.setFilters(current.filters);
    feature.state.setSelectedId(current.selectedId);
    mounted.current = { feature, map };

    if (current.selectedId !== null && feature.detail(current.selectedId) === null) {
      current.onClearSelection();
    }
    feature.onEnter(map, controller.getState().view);

    return () => {
      // Exactly one exit, whether the next commit switches feature, loses the controller or
      // unmounts the app. `onLeave` first, so a feature can read the map it is about to lose.
      feature.onLeave?.(map);
      feature.unmount(map);
      if (mounted.current?.feature === feature) mounted.current = null;
    };
  }, [controller, mapStatus, feature]);
}
