/**
 * WHERE NYC WALKS — the `MapFeature` the registry asks for.
 *
 * `createWalkFeature(data, source)` closes over the shell's two walk objects and returns a
 * `MapFeature<WalkItem, WalkFilters, WalkControls>` that answers every question the
 * registry poses. There is no adapter in between and no second interface: the six gaps that
 * used to be patched in `src/features/shell/featureView.ts` are closed in
 * `src/features/registry.ts`, and this file implements the result.
 *
 * WHY A FACTORY AND NOT A CONSTANT
 * -------------------------------
 * `MapFeature.mount(map)` takes only a map and the interface has no data parameter anywhere,
 * so the data arrives by construction:
 *
 *   const walk = useWalkFeature(enabled);
 *
 * `data` and `source` are both `useMemo` results, so the feature is rebuilt exactly when the
 * artifacts change. Every method below reads through the closure rather than capturing a
 * snapshot, so a rebuild is an optimisation rather than a correctness requirement.
 *
 * WHY EVERY METHOD TOLERATES AN EMPTY FEATURE
 * -----------------------------------------
 * While loading, and after a failed load, the shell still mounts the feature: the map
 * container is in the DOM from the first frame so the layout never jumps (see
 * `src/App.tsx`). So `mount` with the empty index adds the two sources and no data, `rows`
 * returns an empty set, `detail` returns null for every id — including one the shell still
 * holds from the eat feature — and the legend says the honest thing about having nothing to
 * draw. A feature that threw in those states would take the shell down with it.
 *
 * WHY THE CLICK HANDLER LIVES HERE AND NOT IN THE CATALOG
 * ------------------------------------------------------
 * A walk point is selectable, so something has to hit test it and report an id. The shell
 * cannot: it does not know this feature's layer ids, and being told them would make the
 * shell know what a count site is. So the feature attaches its own click listener on
 * `mount`, scopes the hit test to ITS OWN layer ids with
 * `queryRenderedFeatures(point, { layers })` — which is the only correct way to hit test on a
 * map two features share — and reports through `state.setHandlers`. `on` returns the only
 * handle that takes that listener off again, and `unmount` uses it, so a switch cannot leave
 * a click handler bound to somebody else's map.
 *
 * WHY THIS FILE IS `.ts` AND NOT `.tsx`. It names three React slots, and it holds none of
 * the JSX: `./WalkControls` supplies the three render functions and this file only calls
 * them. So `tests/walk-feature.test.ts` can exercise the whole feature — mount, unmount,
 * click, rows, detail, legend — with no React in the module graph at all, which is what
 * makes a failure in any of it readable.
 *
 * `onEnter` preserves the viewport and does nothing else. The shell decided to keep the
 * viewport when it called this, and it is the only party that knows whether a camera is
 * meaningful over a citywide survey map. A feature is deliberately not handed `flyTo`.
 *
 * Public surface:
 *   WALK_IDENTITY, WALK_NOUNS, WALK_COPY (from ./legend)
 *   type WalkFilters, type WalkControls, type WalkFeature
 *   type CreateWalkFeatureOptions, createWalkFeature(data, source, options?): WalkFeature
 */

import type { JSX } from 'react';
import type {
  FeatureData,
  FeatureDetail,
  FeatureHandlers,
  FeatureQuery,
  FeatureRows,
  FeatureRowsQuery,
  LatLngLike,
  LegendConfig,
  MapFeature,
  MapLibreLike,
  MapViewLike,
  SheetSlotContext,
  SortSlotContext,
} from '../registry';
import type { WalkItem } from '../../data/walk/validate';
import type { WalkFeatureSource } from '../../data/walk/source';
import { walkDetail } from './detail';
import { WALK_COPY, WALK_IDENTITY, WALK_NOUNS, walkLegend } from './legend';
import { WALK_CLICKABLE_LAYER_IDS, mountWalkLayers, unmountWalkLayers } from './layers';
import type { WalkLayersHandle } from './layers';
import { walkExtent, walkRows } from './rows';
import { walkLegendSlot, walkSheetSlot, walkSortSlot } from './WalkControls';

export interface CreateWalkFeatureOptions {
  /**
   * The clock, injectable so a test can assert "14 hours ago" without waiting fourteen hours.
   * Defaults to `Date.now`, called on every READ rather than captured once, so a tab left open
   * overnight does not keep saying "just now".
   */
  readonly now?: () => number;
}

/**
 * THIS FEATURE'S FILTER SHAPE, and it is deliberately unconstrained.
 *
 * `src/lib/filters.ts` describes two dimensions that exist because `fpeh-f7ci` publishes
 * them: a dining type and a borough. This feature has neither, so it does not pretend to
 * accept either — and the seam is not widened to hold unrelated dimensions either, which
 * would make `parseUrlState` ambiguous and put a dimension in the URL that nothing on screen
 * can be filtered by. That the fact is true is stated by `controls.filters === null`, which
 * is what the shell reads to decide not to render a rail and not to write a filter into the
 * link.
 *
 * The shape is `unknown` rather than a walk-specific empty object because the shell hands
 * EVERY feature one filter value — it owns the URL — and a narrower type here would be a type
 * the shell cannot satisfy. The parameter exists so this can be said here, in words, instead
 * of being implied by importing Eat Outside's `Filters` and ignoring it.
 */
export type WalkFilters = unknown;

/**
 * The slots this feature fills — and, more usefully, the two it does NOT, stated as types.
 *
 * `filters` and `search` are narrowed to `null` rather than left as the general
 * `((context) => JSX.Element) | null`, so the shell can see STATICALLY that there is no rail
 * and no search box here. That is what the `TControls` parameter on `MapFeature` buys: a
 * `null` slot is information, not merely the absence of a control, and the shell's decision
 * not to render a filter rail — and therefore not to write a filter into the link — follows
 * from the type rather than from a runtime check.
 */
export interface WalkControls {
  readonly filters: null;
  readonly search: null;
  readonly sort: (context: SortSlotContext) => JSX.Element | null;
  readonly legend: (legend: LegendConfig) => JSX.Element;
  readonly sheet: (context: SheetSlotContext) => JSX.Element | null;
}

export type WalkFeature = MapFeature<WalkItem, WalkFilters, WalkControls>;

/**
 * The id off a rendered hit, or null when the hit is not a point of this feature. A cluster
 * bubble has no `id` property, a basemap label has somebody else's, and a hit with neither is
 * not something this feature can open a sheet for.
 */
function hitId(properties: Record<string, unknown> | undefined): string | null {
  const value = properties?.['id'];
  return typeof value === 'string' && value !== '' ? value : null;
}

export function createWalkFeature(
  data: FeatureData<WalkItem>,
  source: WalkFeatureSource,
  options: CreateWalkFeatureOptions = {},
): WalkFeature {
  const now = options.now ?? Date.now;

  /**
   * Live state, in a closure rather than on the returned object so a repeated `mount` reuses
   * the layers that are already there rather than stacking a second set — which, with the
   * `getLayer` guards inside `mountWalkLayers`, is the whole of what "mount must be
   * idempotent" asks for.
   */
  let handle: WalkLayersHandle | null = null;
  let handlers: FeatureHandlers | null = null;
  let detachClick: (() => void) | null = null;
  let selectedId: string | null = null;

  function takeDown(map: MapLibreLike): void {
    detachClick?.();
    detachClick = null;
    handle?.destroy();
    handle = null;
    // Belt and braces, and deliberately after the handle: `unmountWalkLayers` is the
    // module-level teardown, so a feature unmounted twice — or unmounted without ever
    // having been mounted — cannot throw on a layer that is already gone.
    unmountWalkLayers(map);
  }

  return {
    identity: WALK_IDENTITY,

    data,

    state: {
      setFilters(_filters: WalkFilters): void {
        /*
         * Nothing to apply, and the fact is stated by `controls.filters === null` rather
         * than by a silent no-op. A feature that recorded the value would be state nobody
         * reads; a feature that filtered by it would be filtering 114 measurement points by
         * a dimension the source does not have.
         */
      },
      setSelectedId(id: string | null): void {
        selectedId = id;
        handle?.setSelectedId(id);
      },
      setHandlers(next: FeatureHandlers): void {
        handlers = next;
      },
    },

    mount(map: MapLibreLike): void {
      if (handle !== null) {
        // Already mounted. Re-push the data and the selection and return, so neither the
        // layer count nor the listener count can grow with the number of mounts.
        handle.setData(source.index);
        handle.setSelectedId(selectedId);
        return;
      }
      handle = mountWalkLayers(map, source.index);
      if (selectedId !== null) handle.setSelectedId(selectedId);

      const onClick = (event: unknown): void => {
        if (handlers === null) return;
        const point = (event as { readonly point?: unknown } | null)?.point;
        // Scoped to this feature's own layers, so a hit can never be somebody else's.
        const hit = map.queryRenderedFeatures(point, { layers: [...WALK_CLICKABLE_LAYER_IDS] })[0];
        if (hit === undefined) {
          handlers.onClearSelection();
          return;
        }
        const id = hitId(hit.properties);
        // An id this feature cannot resolve is not reported at all. The shell checks again
        // on its own side, and a listener that outlived its layers must not be able to
        // poison the current feature's selection.
        if (id !== null && data.byId.has(id)) handlers.onSelect(id);
      };

      const subscription = map.on('click', onClick);
      detachClick = () => subscription.unsubscribe();
    },

    unmount(map: MapLibreLike): void {
      takeDown(map);
    },

    onEnter(_map: MapLibreLike, _view: MapViewLike): void {
      // Preserved by default. See the module header: the shell owns the camera.
    },

    legend: walkLegend(source.sourceUrl, source.latestUnavailable),

    nouns: WALK_NOUNS,

    copy: WALK_COPY,

    controls: {
      // No rail, no search box, no layer toggles: three `null`s, and the shell renders
      // nothing in those places rather than something empty. In particular there is no
      // search box, because the geocoder the shell owns matches EAT's places — offering it
      // here would answer "no results" for every neighbourhood, which reads as a broken
      // feature rather than as an honest one.
      filters: null,
      search: null,
      sort: walkSortSlot,
      // This feature's swatches are hollow rings, heavy-rimmed discs and an `x` at the
      // centre, all drawn from CSS custom properties the shell's three-shape vocabulary has
      // no class for. So it brings the legend that draws them.
      legend: walkLegendSlot,
      sheet: (context) => walkSheetSlot(context, data, source, now()),
    },

    rows(query: FeatureRowsQuery<WalkFilters>): FeatureRows {
      return walkRows({
        index: source.index,
        origin: query.origin === null ? null : { lat: query.origin.lat, lng: query.origin.lng },
        sort: query.sort,
        limit: query.limit,
        bounds: query.bounds,
        now: now(),
      });
    },

    extent(_query: FeatureQuery<WalkFilters>) {
      return walkExtent(source.index);
    },

    positionOf(id: string): LatLngLike | null {
      const coords = source.index.coords.get(id);
      return coords === undefined ? null : { lat: coords.lat, lng: coords.lng };
    },

    detail(id: string): FeatureDetail | null {
      // `byId.get` on a Map is total and returns undefined for an unknown key, which is the
      // whole mechanism behind "a selection left over from the other feature clears": a
      // `wsk-` id is not in this map and neither is a stale `wsh-` from an older pipeline.
      return walkDetail(data.byId.get(id), source.patterns, source.latestById, now());
    },
  };
}
