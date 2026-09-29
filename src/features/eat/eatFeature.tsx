/**
 * THE EAT OUTSIDE FEATURE.
 *
 * This is the whole of what "Eat Outside NYC" means, in one object, behind the registry's
 * interface. Before the registry it was `App.tsx`: the layer source and every layer, the
 * filter rail, the legend, the list predicate, the detail sheet, the loading copy and the
 * "no places in this area" prose. Now the shell asks one object for all of it and never
 * learns what a borough is.
 *
 * WHY A FACTORY AND NOT A CONSTANT
 * ---------------------------------
 * `MapFeature.mount(map)` takes only a map, and the interface has no data parameter
 * anywhere, so the data arrives by construction:
 *
 *   const feature = useMemo(() => createEatFeature(input), [input]);
 *
 * `input` is a `useMemo` result, so the feature is rebuilt exactly when the artifacts
 * change. Every method reads through the closure rather than capturing a snapshot, so a
 * rebuild is an optimisation rather than a correctness requirement.
 *
 * WHY EVERY METHOD TOLERATES AN EMPTY FEATURE
 * -------------------------------------------
 * While loading, and after a failed load, the shell still mounts the feature: the map
 * container is in the DOM from the first frame so the layout never jumps. So `mount` with
 * no collection adds nothing, `rows` returns an empty set, and `detail` returns null for
 * every id — including one the shell still holds from another feature. A feature that threw
 * in those states would take the shell down with it.
 *
 * `onEnter` preserves the viewport and does nothing else. The shell decided to keep the
 * viewport when it called this, and it is the only party that knows whether a camera is
 * meaningful over a dataset it cannot see. A feature is deliberately not handed `flyTo`.
 *
 * WHY THE CONTROLS ARE THREE SLOTS AND THREE `null`s. `search` and `sheet` are components
 * this feature brings; `sort` and `legend` are `null` because the shell already draws them
 * correctly for this feature — its list has exactly one order worth offering, and its three
 * swatch shapes are the shell's own. See `FeatureControls` for why a `null` slot means the
 * shell renders nothing rather than something empty.
 *
 * Public surface:
 *   EAT_IDENTITY, PLACE_NOUNS (from ./legend)
 *   type EatFeatureInput, type EatFeature, createEatFeature(input): EatFeature
 */

import type { DatasetMetadata, LocationCollection, LocationProperties } from '../../types/location';
import type { LatLng } from '../../lib/distance';
import type { Filters } from '../../lib/filters';
import { NO_FILTER } from '../../lib/filters';
import { formatUpdatedAt } from '../../lib/format';
import { DATA_ATTRIBUTION_TEXT } from '../../lib/attribution';
import type { DatasetStatus } from '../../data/useDataset';
import type {
  FeatureControls,
  FeatureHandlers,
  FeatureQuery,
  FeatureRows,
  LatLngLike,
  LegendConfig,
  MapFeature,
  MapLibreLike,
  MapViewLike,
} from '../registry';
import { EAT_LEGEND, PLACE_NOUNS } from './legend';
import { addEatLayers, attachEatInteractions, removeEatLayers } from './layers';
import type { EatLayers } from './layers';
import { eatDetail, eatExtent, eatRows } from './rows';
import { FilterRail } from './FilterRail';
import { DetailSheet } from './DetailSheet';
import { SearchBox } from '../../components/SearchBox';

export const EAT_IDENTITY = {
  id: 'eat',
  // The site's own name, so the switcher's first option and the h1 are the same words and
  // the document title for this feature needs no suffix — see `documentTitleFor` below.
  label: 'Eat Outside NYC',
  description: 'Where you can legally eat outside, from the city’s own licence data.',
  attribution: 'NYC Open Data · Dining Out NYC Locations (fpeh-f7ci)',
} as const;

export interface EatFeatureInput {
  readonly status: DatasetStatus;
  readonly locations: readonly LocationProperties[];
  readonly byId: ReadonlyMap<string, LocationProperties>;
  readonly coords: ReadonlyMap<string, LatLng>;
  /** The validated FeatureCollection, needed by the map source. Null until it is indexed. */
  readonly collection: LocationCollection | null;
  readonly metadata: DatasetMetadata | null;
  readonly error: Error | null;
  readonly retry: () => void;
}

const EMPTY_ROWS: FeatureRows = { rows: [], total: 0, datasetCount: 0, filtered: false };

/** The concrete type this module produces, written out once. */
export type EatFeature = MapFeature<LocationProperties, Filters, FeatureControls<Filters>>;

/**
 * Memoises the list predicate. `rows` is called during render on every frame the map moves,
 * and the predicate walks 2 000 locations, so without this the app would do 2 000 filter
 * comparisons per camera frame for a result that did not change.
 */
function memoizeRows(input: EatFeatureInput): EatFeature['rows'] {
  let previousKey: unknown[] | null = null;
  let previous: FeatureRows = EMPTY_ROWS;
  return (options) => {
    const key = [
      input.locations,
      input.coords,
      options.filters,
      options.bounds,
      options.origin,
      options.limit,
    ];
    if (previousKey !== null && sameKey(previousKey, key)) return previous;
    previousKey = key;
    previous = eatRows({ ...input, ...options });
    return previous;
  };
}

function sameKey(a: readonly unknown[], b: readonly unknown[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

export function createEatFeature(input: EatFeatureInput): EatFeature {
  /**
   * The live state, in a closure rather than on the returned object, so a repeated `mount`
   * reuses the layers already there instead of stacking a second set — which, together with
   * the `getLayer` guards inside `addEatLayers`, is the whole of what "mount must be
   * idempotent" asks for.
   */
  let layers: EatLayers | null = null;
  let detachInteractions: (() => void) | null = null;
  let handlers: FeatureHandlers | null = null;
  let filters: Filters = NO_FILTER;
  let selectedId: string | null = null;
  const rows = memoizeRows(input);

  /**
   * Takes down everything this feature put on the map, in one place, so `unmount` and the
   * "the data arrived after the map was already up" path cannot drift apart.
   */
  function takeDown(map: MapLibreLike): void {
    detachInteractions?.();
    detachInteractions = null;
    layers = null;
    removeEatLayers(map);
  }

  return {
    identity: EAT_IDENTITY,

    data: {
      status: input.status,
      items: input.locations,
      byId: input.byId,
      error: input.error,
      retry: input.retry,
      // The provenance line, built from `metadata.retrievedAt` and never from a literal date.
      provenance: formatUpdatedAt(input.metadata),
    },

    state: {
      setFilters(next: Filters): void {
        filters = next;
        layers?.setFilters(next);
      },
      setSelectedId(id: string | null): void {
        selectedId = id;
        layers?.setSelectedId(id);
      },
      setHandlers(next: FeatureHandlers): void {
        handlers = next;
      },
    },

    mount(map: MapLibreLike): void {
      if (layers !== null) {
        // Already mounted. Re-push the two pieces of live state and return, so the layer
        // count cannot grow with the number of mounts.
        layers.setFilters(filters);
        layers.setSelectedId(selectedId);
        return;
      }
      if (input.collection === null) return;
      layers = addEatLayers(map, input.collection, filters);
      if (selectedId !== null) layers.setSelectedId(selectedId);
      detachInteractions = attachEatInteractions(map, {
        onSelect: (id) => handlers?.onSelect(id),
        onClearSelection: () => handlers?.onClearSelection(),
        onError: (error) => handlers?.onError(error),
      });
    },

    unmount(map: MapLibreLike): void {
      takeDown(map);
    },

    onEnter(_map: MapLibreLike, _view: MapViewLike): void {
      // Preserved by default. See the module header: the shell owns the camera.
    },

    legend: EAT_LEGEND as LegendConfig,

    nouns: PLACE_NOUNS,

    copy: {
      mapLabel: 'Map of participating outdoor dining places in New York City',
      data: {
        loading: {
          title: 'Loading places',
          body:
            'Fetching the Dining Out NYC locations published by the city. This runs once ' +
            'and is then cached by the browser.',
        },
        failure: {
          title: 'The place list did not load',
          body:
            'Nothing is shown because an empty map would look like “there are no outdoor ' +
            `dining places here”, which is not something this app knows. ${DATA_ATTRIBUTION_TEXT}`,
        },
      },
      filtering: {
        dimensions: 'dining type and borough',
        retryHint: 'Try a different dining type, or a different borough.',
      },
    },

    rows,

    extent(query: FeatureQuery<Filters>) {
      return eatExtent({ locations: input.locations, coords: input.coords, filters: query.filters });
    },

    positionOf(id: string): LatLngLike | null {
      return input.coords.get(id) ?? null;
    },

    detail(id: string) {
      const location = input.byId.get(id);
      // A well-formed id that is not in the dataset — a shared link from an older refresh, or
      // a selection left over from the other feature — resolves to null rather than to an
      // empty sheet. `coords` is checked too, because a place the map cannot draw has no
      // position to fly to and its sheet would promise one.
      if (location === undefined || !input.coords.has(id)) return null;
      return eatDetail(location, input.coords, input.metadata, null);
    },

    controls: {
      filters: ({ filters: current, onChange, disabled }) => (
        <FilterRail
          locations={input.locations}
          filters={current}
          onChange={onChange}
          disabled={disabled}
        />
      ),
      search: ({ onPickArea, onPickItem, ...rest }) => (
        <SearchBox
          locations={input.locations}
          onPickArea={onPickArea}
          onPickRestaurant={onPickItem}
          {...(rest.geocode === undefined ? {} : { geocode: rest.geocode })}
        />
      ),
      // Eat Outside sorts its 2 000 places by name and has no other order to offer, so it
      // declares no sort control: a radiogroup of one option is a control that cannot change
      // anything. The shell renders nothing rather than an empty group.
      sort: null,
      // The shell's generic `ShellLegend` draws these three swatches from the three shapes
      // in `src/map/style.ts`, which is the stylesheet it shares with the map. No slot.
      legend: null,
      sheet: ({ id, onClose, onShowOnMap, origin }) => {
        const location = input.byId.get(id);
        const position = input.coords.get(id);
        // The shell only opens the sheet for an id this feature resolved, so both lookups
        // are total here. Rendered as a fragment-like null rather than a half-sheet.
        if (location === undefined || position === undefined) return null;
        return (
          <DetailSheet
            location={location}
            coords={position}
            metadata={input.metadata}
            origin={origin}
            onClose={onClose}
            {...(onShowOnMap === undefined ? {} : { onShowOnMap })}
          />
        );
      },
    },
  };
}
