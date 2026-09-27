/**
 * INTEGRATION NOTES (src/App.tsx)
 *
 * The whole UI. One component tree, one state owner per concern, and no second copy of
 * anything the map controller already knows.
 *
 * STATE OWNERSHIP
 *   the map controller  map camera, filters, selectedId, visible bounds, map error.
 *                       Read with `useSyncExternalStore`; WRITTEN ONLY through its methods
 *                       (`setFilters`, `setSelectedId`, `focusOn`, `flyTo`, `fitTo*`). The
 *                       detail sheet is derived from `state.selectedId` — there is no
 *                       parallel "openSheet" boolean that could disagree with the map.
 *   `useDataset`       locations, byId, coords, metadata, load error, reload.
 *   `useGeolocation`   the visitor's fix, and only ever after an explicit tap.
 *   this component     viewMode (map|list), filtersOpen, revealed row count, skip-link
 *                       intent. Nothing that the map already holds.
 *   the URL            written from (view, filters, selectedId) on a debounce. It is a
 *                       mirror, never a source: nothing reads it back after first load.
 *
 * WHAT IS DELIBERATELY ABSENT
 *   No geolocation request on load, on search, on filter change, or on a shared link.
 *   No geolocation in the URL, ever (`serializeUrlState` has no key for it).
 *   No hours, "open now", rating, price, cuisine, menu or phone. The source has none of
 *   them, so neither does the UI.
 *   No "nearby" distance unless there is a real position to measure from.
 *
 * THE FIRST FRAME. The map container is always in the DOM, even while the dataset is
 * loading, so the layout never jumps and the loading state covers a real surface rather
 * than appearing after a reflow. Nothing is created until there is a dataset to draw.
 */

import type { JSX } from 'react';
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { useDataset } from './data/useDataset';
import type { LoadedDataset } from './data/load';
import type { GeocodeResult } from './lib/geocode';
import type { Filters } from './lib/filters';
import { NO_FILTER, countFor, isFiltered } from './lib/filters';
import { formatBoroughCount } from './lib/format';
import { DEFAULT_VIEW } from './lib/urlState';
import type { UrlState } from './lib/urlState';
import { LABEL_STYLE } from './map/style';
import { useMapController } from './hooks/useMapController';
import type { MapControllerFactory } from './hooks/useMapController';
import { useGeolocation } from './hooks/useGeolocation';
import type { UseGeolocationOptions } from './hooks/useGeolocation';
import { useLocationCollection } from './hooks/useLocationCollection';
import { DEFAULT_VISIBLE_LIMIT, useVisibleCount, useVisibleLocations } from './hooks/useVisibleLocations';
import { readInitialUrlState, useUrlStateSync } from './hooks/useUrlState';
import { SearchBox } from './components/SearchBox';
import type { SearchBoxProps } from './components/SearchBox';
import { FiltersButton, FilterPanel } from './components/FilterPanel';
import { LocationList, ViewToggle } from './components/LocationList';
import { DetailSheet } from './components/DetailSheet';
import { MapLegend } from './components/MapLegend';
import { UserLocationMarker } from './components/UserLocationMarker';
import { DatasetErrorState, DatasetLoadingState, MapErrorState, MapLoadingState } from './components/StateCards';
import { CloseIcon, NearMeIcon } from './components/icons';

export type ViewMode = 'map' | 'list';

/**
 * The half-extent, in degrees, of the box a place search is framed in. Two degrees of
 * latitude at NYC is roughly 2 km, so a hit lands you in the neighbourhood with room to see
 * the alternatives rather than on a lone pin.
 */
const PLACE_FRAME_DEGREES = { lng: 0.012, lat: 0.008 };

/**
 * The zoom the Near Me flow lands on. `LABEL_STYLE.minZoom` is the map's own "every cluster
 * has dissolved and every point is labelled" zoom — the same value the controller exports as
 * `FOCUS_ZOOM` — so reusing it keeps the app from inventing a second opinion about how close
 * is close. Read from `style.ts` rather than `controller.ts` so the UI layer never pulls the
 * map engine into its module graph.
 */
const NEARBY_ZOOM = LABEL_STYLE.minZoom;

export interface AppProps {
  /**
   * The one binding between the UI and the map engine. `main.tsx` passes the real
   * `createMapController`; component tests pass a fake, because jsdom has no WebGL. It is
   * required rather than defaulted so that forgetting it is a type error instead of a
   * silently empty map.
   */
  readonly createController: MapControllerFactory;
  /** URL write debounce. Tests pass 0 to make assertions deterministic. */
  readonly urlDelayMs?: number;
  /** Injected in tests so the geocoder never touches the network. */
  readonly geocode?: SearchBoxProps['geocode'];
  /** Injected in tests so `getCurrentPosition` can be driven deterministically. */
  readonly geolocation?: UseGeolocationOptions['geolocation'];
}

export function App({ createController, urlDelayMs, geocode, geolocation }: AppProps): JSX.Element {
  const dataset = useDataset();
  const collection = useLocationCollection(dataset.status);

  // Parsed ONCE, lazily, before the controller exists. After this the URL is write-only.
  const [initialUrl] = useState(readInitialUrlState);

  const [viewMode, setViewMode] = useState<ViewMode>('map');
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [revealed, setRevealed] = useState(DEFAULT_VISIBLE_LIMIT);
  const [container, setContainer] = useState<HTMLDivElement | null>(null);

  const filtersPanelId = useId();
  const listHeadingRef = useRef<HTMLHeadingElement | null>(null);
  // Set only by the skip link, so switching to the list normally does not steal focus.
  const focusListAfterSwitch = useRef(false);

  const geo = useGeolocation(geolocation === undefined ? {} : { geolocation });

  const loaded = useMemo<LoadedDataset | null>(() => {
    if (collection === null || dataset.status !== 'ready' || dataset.metadata === null) {
      return null;
    }
    return {
      collection,
      locations: dataset.locations,
      byId: dataset.byId,
      coords: dataset.coords,
      metadata: dataset.metadata,
    };
  }, [collection, dataset]);

  const { controller, state: mapState } = useMapController({
    container,
    dataset: loaded,
    initialView: initialUrl.view,
    initialFilters: initialUrl.filters,
    initialSelectedId: initialUrl.selectedId,
    create: createController,
  });

  const filters = mapState.filters;
  const selectedId = mapState.selectedId;
  const selected = selectedId === null ? null : dataset.byId.get(selectedId) ?? null;
  const selectedCoords = selected === null ? null : dataset.coords.get(selected.id) ?? null;
  const sheetOpen = selected !== null && selectedCoords !== null;

  const countOptions = useMemo(
    () => ({
      locations: dataset.locations,
      coords: dataset.coords,
      filters,
      bounds: mapState.bounds,
    }),
    [dataset.locations, dataset.coords, filters, mapState.bounds],
  );

  const visible = useVisibleLocations({
    ...countOptions,
    origin: geo.position,
    limit: revealed,
  });
  const inViewTotal = useVisibleCount(countOptions);
  const datasetCount = useMemo(
    () => countFor(dataset.locations, filters),
    [dataset.locations, filters],
  );

  /**
   * WHAT THE LINK SHARES.
   *
   * Normally the URL mirrors the camera, so a shared link restores the map, the filters and
   * the selection. But "normally" excludes the case where we are holding a visitor's
   * position: Near Me flies the camera to that fix, the camera is state the URL mirrors, and
   * the result is a shareable link that carries somebody's location to four decimal places.
   *
   * So while a fix is held the URL carries the filters and the selection and nothing else.
   * `serializeUrlState` already omits a default view, so passing `DEFAULT_VIEW` writes no
   * `lat`/`lng`/`z` at all — the link is honest about the map ("the whole city, plus these
   * filters") rather than quietly precise about a person. The moment the visitor turns the
   * position off, the camera starts being mirrored again.
   *
   * This is belt and braces on top of a type that has nowhere to put a position: `UrlState`
   * has no member for one, and `serializeUrlState` writes only six whitelisted keys.
   */
  const userPosition = geo.status === 'ready' ? geo.position : null;
  const urlState = useMemo<UrlState>(
    () =>
      userPosition === null
        ? { view: mapState.view, filters, selectedId }
        : { view: DEFAULT_VIEW, filters, selectedId },
    [userPosition, mapState.view, filters, selectedId],
  );

  useUrlStateSync(urlState, {
    enabled: controller !== null,
    ...(urlDelayMs === undefined ? {} : { delayMs: urlDelayMs }),
  });

  // A tighter filter set means the previously revealed page size is meaningless.
  useEffect(() => {
    setRevealed(DEFAULT_VISIBLE_LIMIT);
  }, [filters]);

  // Near Me success: centre on the visitor, at the zoom where the labels are legible.
  useEffect(() => {
    if (controller === null || userPosition === null) return;
    controller.flyTo({
      lng: userPosition.lng,
      lat: userPosition.lat,
      zoom: NEARBY_ZOOM,
    });
  }, [controller, userPosition]);

  // The map is inside a container whose size the sheet and the view toggle both change.
  useEffect(() => {
    controller?.resize();
  }, [controller, sheetOpen, viewMode]);

  useEffect(() => {
    if (viewMode !== 'list' || !focusListAfterSwitch.current) return;
    focusListAfterSwitch.current = false;
    listHeadingRef.current?.focus();
  }, [viewMode]);

  const handleSelect = useCallback(
    (id: string) => {
      controller?.focusOn(id);
    },
    [controller],
  );

  const handlePickArea = useCallback(
    (result: GeocodeResult) => {
      if (controller === null) return;
      // Fit a small box rather than dropping a single pin: a geocoded place is usually a
      // neighbourhood or a ZIP centroid, and a lone dot at z15 would be a lie about scale.
      controller.fitTo({
        west: result.lng - PLACE_FRAME_DEGREES.lng,
        south: result.lat - PLACE_FRAME_DEGREES.lat,
        east: result.lng + PLACE_FRAME_DEGREES.lng,
        north: result.lat + PLACE_FRAME_DEGREES.lat,
      });
      setViewMode('map');
    },
    [controller],
  );

  const handleFilters = useCallback(
    (next: Filters) => {
      controller?.setFilters(next);
    },
    [controller],
  );

  const activeFilterCount =
    (filters.type !== 'all' ? 1 : 0) + (filters.borough !== 'all' ? 1 : 0);

  const ready = dataset.status === 'ready' && loaded !== null && controller !== null;
  const geoBusy = geo.status === 'locating';

  return (
    <div className="eoy-app">
      {/* Everything behind the sheet, so `aria-modal` on the sheet is a true statement. */}
      <div className="eoy-app__body" inert={sheetOpen}>
        <button
          type="button"
          className="eoy-skip-link"
          onClick={() => {
            focusListAfterSwitch.current = true;
            setViewMode('list');
          }}
        >
          Skip to the list of places
        </button>

        <header className="eoy-header">
          <h1 className="eoy-wordmark">
            <span className="eoy-wordmark__dot" aria-hidden="true" />
            Eat Outside NYC
          </h1>

          <SearchBox
            locations={dataset.locations}
            onPickArea={handlePickArea}
            onPickRestaurant={handleSelect}
            {...(geocode === undefined ? {} : { geocode })}
          />

          <button
            type="button"
            className="eoy-button eoy-button--on-dark"
            onClick={geo.request}
            disabled={!ready || geoBusy}
            aria-describedby="eoy-nearme-hint"
          >
            <NearMeIcon />
            <span>{geoBusy ? 'Locating' : 'Near me'}</span>
          </button>
          <span className="eoy-visually-hidden" id="eoy-nearme-hint">
            Asks your browser for your position once. Your position is never stored and never
            added to the address of this page.
          </span>

          <FiltersButton
            open={filtersOpen}
            disabled={!ready}
            activeCount={activeFilterCount}
            onToggle={() => setFiltersOpen((open) => !open)}
            controls={filtersPanelId}
          />

          <FilterPanel
            open={filtersOpen}
            locations={dataset.locations}
            filters={filters}
            onChange={handleFilters}
            onClose={() => setFiltersOpen(false)}
            panelId={filtersPanelId}
          />
        </header>

        <main className="eoy-stage">
          <div
            className="eoy-map"
            hidden={viewMode !== 'map'}
            ref={setContainer}
            tabIndex={-1}
            role="region"
            aria-label="Map of participating outdoor dining places in New York City"
            data-testid="map-canvas"
          />

          {viewMode === 'map' && ready ? <MapLegend /> : null}
          {/* Not gated on the view mode: a "permission declined" message must still be
              there when the visitor reads the list, because reading the list is the
              fallback the message itself points at. */}
          {userPosition !== null ? (
            <p className="eoy-user-chip">
              <span className="eoy-user-chip__dot" aria-hidden="true" />
              <span>Using your location</span>
              <button type="button" className="eoy-button eoy-button--small" onClick={geo.clear}>
                <CloseIcon size={12} />
                Turn off
              </button>
            </p>
          ) : null}
          {geo.message !== null ? (
            <div className="eoy-notice" role="status">
              <p className="eoy-notice__text">{geo.message}</p>
              <button
                type="button"
                className="eoy-button eoy-button--small"
                onClick={geo.clear}
              >
                Dismiss
              </button>
            </div>
          ) : null}

          {dataset.status === 'loading' ? <DatasetLoadingState /> : null}
          {dataset.status === 'error' ? (
            <DatasetErrorState error={dataset.error} onRetry={dataset.reload} />
          ) : null}
          {ready && mapState.status === 'loading' ? <MapLoadingState /> : null}
          {ready && mapState.status === 'error' ? <MapErrorState error={mapState.error} /> : null}

          {ready ? (
            <LocationList
              visible={viewMode === 'list'}
              rows={visible}
              total={inViewTotal}
              datasetCount={datasetCount}
              filtered={isFiltered(filters)}
              selectedId={selectedId}
              revealed={revealed}
              headingRef={listHeadingRef}
              onRevealMore={() => setRevealed((value) => value + DEFAULT_VISIBLE_LIMIT)}
              onSelect={handleSelect}
              onZoomToAll={() => controller?.fitToResults()}
              onClearFilters={() => controller?.setFilters(NO_FILTER)}
            />
          ) : null}
        </main>

        {ready ? (
          <footer className="eoy-bottom-bar">
            <p className="eoy-bottom-bar__count">
              {formatBoroughCount(inViewTotal)} in this area
            </p>
            <ViewToggle
              mode={viewMode}
              onChange={setViewMode}
              listCount={inViewTotal}
            />
          </footer>
        ) : null}
      </div>

      <UserLocationMarker controller={controller} position={userPosition} />

      {sheetOpen && selected !== null && selectedCoords !== null ? (
        <DetailSheet
          location={selected}
          coords={selectedCoords}
          metadata={dataset.metadata}
          origin={userPosition}
          onClose={() => controller?.setSelectedId(null)}
          {...(viewMode === 'list' ? { onShowOnMap: () => setViewMode('map') } : {})}
        />
      ) : null}
    </div>
  );
}
