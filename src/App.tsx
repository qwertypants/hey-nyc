/**
 * INTEGRATION NOTES (src/App.tsx)
 *
 * The SHELL. One component tree, one state owner per concern, and no second copy of
 * anything the map controller already knows.
 *
 * This file used to be the whole UI, and it knew what Eat Outside was: it fetched the
 * dataset, asked the controller for a source and six layers, rendered a filter rail of
 * dining types and boroughs, computed the list with `useVisibleLocations`, and rendered a
 * detail sheet about licences. It does none of that now. It owns the parts that are true of
 * every feature — the header, the mode switcher, the map container, geolocation, the URL
 * mirror, the mobile layout, and the generic list / legend / sheet — and asks the catalog for
 * a `MapFeature` to fill the rest. The words "dining", "borough" and "cafes" do not appear
 * below, and adding a third feature changes no line of this file.
 *
 * STATE OWNERSHIP
 *   the map controller  map camera, the visible extent, the mirrors of the active feature's
 *                       filters and selection, map status, map error. Read with
 *                       `useSyncExternalStore`; WRITTEN ONLY through its methods. The detail
 *                       sheet is derived from `state.selectedId` — there is no parallel
 *                       "openSheet" boolean that could disagree with the map.
 *   the active feature  its data, its layers, its legend, its list predicate, its detail,
 *                       its filters and its own words. See `src/features/registry.ts`.
 *   `useGeolocation`    the visitor's fix, and only ever after an explicit tap.
 *   the per-feature bag one `Filters` value per feature id, so switching cannot carry one
 *                       feature's filter into another's URL. See `handleSelectFeature`.
 *   this component      viewMode (map|list), revealed row count, skip-link intent, the
 *                       filter-change announcement, and which feature is selected. Nothing
 *                       that the map already holds.
 *   the URL             written from (mode, view, filters, selectedId) on a debounce. It is
 *                       a mirror, never a source: nothing reads it back after first load.
 *
 * WHAT IS DELIBERATELY ABSENT
 *   No geolocation request on load, on search, on filter change, or on a shared link.
 *   No geolocation in the URL, ever (`serializeUrlState` has no key for it).
 *   No hours, "open now", rating, price, cuisine, menu or phone. The source has none of
 *   them, so neither does the UI.
 *   No "nearby" distance unless there is a real position to measure from.
 *
 * THE FIRST FRAME. The map container is always in the DOM, even while a feature's data is
 * loading, so the layout never jumps and the loading state covers a real surface rather
 * than appearing after a reflow. The MAP ITSELF is created as soon as the container exists,
 * which is EARLIER than it used to be — it used to wait for a dataset. Nothing is drawn
 * until a feature is mounted, and that happens only once the basemap style has loaded.
 */

import type { JSX } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { GeocodeResult } from './lib/geocode';
import type { Filters } from './lib/filters';
import { NO_FILTER, isFiltered } from './lib/filters';
import { DEFAULT_VIEW } from './lib/urlState';
import type { UrlState } from './lib/urlState';
import { LABEL_STYLE } from './map/style';
import { useMapController } from './hooks/useMapController';
import type { MapControllerFactory } from './hooks/useMapController';
import { useGeolocation } from './hooks/useGeolocation';
import type { UseGeolocationOptions } from './hooks/useGeolocation';
import { readInitialUrlState, useUrlStateSync } from './hooks/useUrlState';
import type { SearchBoxProps } from './components/SearchBox';
import { UserLocationMarker } from './components/UserLocationMarker';
import {
  DataErrorState,
  DataLoadingState,
  MapErrorState,
  MapLoadingState,
} from './components/StateCards';
import { NearMeIcon } from './components/icons';
import type { FeatureId } from './features/registry';
import { FeatureSwitcher } from './features/shell/FeatureSwitcher';
import { ShellList, DEFAULT_VISIBLE_LIMIT } from './features/shell/ShellList';
import { ShellLegend } from './features/shell/ShellLegend';
import { ShellDetailSheet } from './features/shell/ShellDetailSheet';
import { useActiveFeature } from './features/shell/useActiveFeature';
import { useFeatureCatalog } from './features/shell/useFeatureCatalog';
import { formatPluralizedCount } from './lib/format';
import type { WalkSort } from './features/registry';
import type { ViewMode } from './features/shell/ViewToggle';
import { ViewToggle } from './features/shell/ViewToggle';

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

/** The site's own name, and the document title for the feature that shares it. */
const SITE_NAME = 'Eat Outside NYC';

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
  // Parsed ONCE, lazily, before the controller exists. After this the URL is write-only.
  const [initialUrl] = useState(readInitialUrlState);

  const [featureId, setFeatureId] = useState<FeatureId>(initialUrl.mode);
  const { feature, features } = useFeatureCatalog(featureId);

  const [viewMode, setViewMode] = useState<ViewMode>('map');
  const [revealed, setRevealed] = useState(DEFAULT_VISIBLE_LIMIT);
  const [container, setContainer] = useState<HTMLDivElement | null>(null);
  /*
   * THE ORDER THE LIST IS IN, or null before the visitor has chosen one. Held here rather
   * than in the controller because it is not mirrored into the URL: it is a reading
   * preference, not a place, and a link that pinned it would be a link that opened onto
   * somebody else's idea of "nearest". A feature with no sort control declares
   * `controls.sort: null` and never reads it.
   */
  const [sort, setSort] = useState<WalkSort | null>(null);

  const listHeadingRef = useRef<HTMLHeadingElement | null>(null);
  // Set only by the skip link, so switching to the list normally does not steal focus.
  const focusListAfterSwitch = useRef(false);

  const geo = useGeolocation(geolocation === undefined ? {} : { geolocation });

  const { controller, state: mapState } = useMapController({
    container,
    // One map, built once there is a feature to put on it. See `UseMapControllerOptions`.
    enabled: feature.data.status === 'ready',
    initialView: initialUrl.view,
    initialFilters: initialUrl.filters,
    initialSelectedId: initialUrl.selectedId,
    create: createController,
  });

  const filters = mapState.filters;
  const selectedId = mapState.selectedId;
  const copy = feature.copy;
  const nouns = feature.nouns;
  const controls = feature.controls;

  // Slots are held in local names because a JSX tag has to start with a capital, and because
  // reading `controls.search` four times in a render hides which control is which.
  const SearchSlot = controls.search;
  const FilterSlot = controls.filters;
  const SortSlot = controls.sort;
  const LegendSlot = controls.legend;
  const SheetSlot = controls.sheet;

  const data = feature.data;
  // Derived, never a parallel boolean: a sheet is open exactly when the ACTIVE feature can
  // resolve the current selection. An id belonging to the other feature resolves to null, so
  // the sheet closes by itself on a switch rather than rendering an empty panel.
  const detail = selectedId === null ? null : feature.detail(selectedId);
  const sheetOpen = detail !== null;

  /*
   * ONE FILTER VALUE PER FEATURE.
   *
   * The controller holds the active feature's filters because the URL is written from one
   * place, and the rail writes through it. But the VALUE belongs to the feature: switch to
   * walk, which has no dimensions, and "borough=Queens" must not follow — neither into the
   * URL, which would then describe a filter the visitor cannot see or undo, nor into the
   * returning feature's rail, which would resurrect a filter nobody asked for again. So the
   * previous value is filed under the outgoing id on the way out and the incoming id's value
   * is pushed in on the way in.
   *
   * A feature with no filter control writes `NO_FILTER` into the URL whatever the bag holds,
   * so the link always describes something the visitor can see. And the link's own filters
   * are filed under the feature the link is ABOUT, which is the only reading of
   * `?mode=walk&type=roadway` that is not a lie: the filters were named, walk has no
   * dimensions to apply them to, and Eat Outside is where they will take effect.
   */
  const [filterBag] = useState<Record<FeatureId, Filters>>(() => ({
    eat: NO_FILTER,
    walk: NO_FILTER,
    ...{ [initialUrl.mode]: initialUrl.filters },
  }));

  const activeFilters = FilterSlot === null ? NO_FILTER : filters;

  const handleFilters = useCallback(
    (next: Filters) => {
      filterBag[featureId] = next;
      controller?.setFilters(next);
    },
    [controller, featureId, filterBag],
  );

  const handleSelectFeature = useCallback(
    (next: FeatureId) => {
      if (next === featureId) return;
      filterBag[featureId] = filters;
      controller?.setFilters(filterBag[next]);
      setFeatureId(next);
    },
    [controller, featureId, filters, filterBag],
  );

  const clearSelection = useCallback(() => {
    controller?.setSelectedId(null);
  }, [controller]);

  const handleSelect = useCallback(
    (id: string) => {
      // The active feature is the only thing that can turn an id into a place, so it is the
      // one that refuses: an id from the other feature moves nothing and selects nothing.
      controller?.focusOn(id, feature.positionOf(id));
    },
    [controller, feature],
  );

  const handleMapSelect = useCallback(
    (id: string) => {
      // Only an id the ACTIVE feature can resolve is recorded. A click handler that outlived
      // its layers — which is exactly what a feature that forgets to detach would leave
      // behind — must not be able to poison the current feature's selection with an id from
      // the one that has just been unmounted.
      if (feature.detail(id) === null) return;
      controller?.setSelectedId(id);
    },
    [controller, feature],
  );

  /**
   * A feature reporting a problem of its own — a cluster that would not expand, say — is
   * NOT a basemap failure, and must not replace the map with an error chip over data that is
   * still perfectly readable. So it goes to the console, which is what `AGENTS.md` allows
   * `console.error` for, and the visitor carries on with a feature that still draws.
   */
  const handleFeatureError = useCallback((error: Error) => {
    console.error('a map feature reported a problem', error);
  }, []);

  useActiveFeature({
    controller,
    mapStatus: mapState.status,
    feature,
    filters,
    selectedId,
    onSelect: handleMapSelect,
    onClearSelection: clearSelection,
    onError: handleFeatureError,
  });

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

  const userPosition = geo.status === 'ready' ? geo.position : null;

  const query = useMemo(
    () => ({ filters, bounds: mapState.bounds, origin: userPosition, sort }),
    [filters, mapState.bounds, userPosition, sort],
  );

  // The list predicate is the feature's, and it walks the whole dataset, so it is memoised
  // here on the four things that can change its answer.
  const listing = useMemo(
    () => feature.rows({ ...query, limit: revealed }),
    [feature, query, revealed],
  );

  /**
   * WHAT THE LINK SHARES.
   *
   * Normally the URL mirrors the camera, so a shared link restores the feature, the map, the
   * filters and the selection. But "normally" excludes the case where we are holding a
   * visitor's position: Near Me flies the camera to that fix, the camera is state the URL
   * mirrors, and the result is a shareable link that carries somebody's location to four
   * decimal places.
   *
   * So while a fix is held the URL carries the feature, the filters and the selection and
   * nothing else. `serializeUrlState` already omits a default view, so passing `DEFAULT_VIEW`
   * writes no `lat`/`lng`/`z` at all — the link is honest about the map ("the whole city, plus
   * these filters") rather than quietly precise about a person. The moment the visitor turns
   * the position off, the camera starts being mirrored again. `mode` is NOT suppressed by a
   * held fix: a feature is not a person's location, and a link that silently dropped it would
   * open a different map than the one it was copied from.
   *
   * This is belt and braces on top of a type that has nowhere to put a position: `UrlState`
   * has no member for one, and `serializeUrlState` writes only seven whitelisted keys.
   */
  const urlState = useMemo<UrlState>(
    () =>
      userPosition === null
        ? { mode: featureId, view: mapState.view, filters: activeFilters, selectedId }
        : { mode: featureId, view: DEFAULT_VIEW, filters: activeFilters, selectedId },
    [userPosition, featureId, mapState.view, activeFilters, selectedId],
  );

  useUrlStateSync(urlState, {
    enabled: controller !== null,
    ...(urlDelayMs === undefined ? {} : { delayMs: urlDelayMs }),
  });

  // The document title follows the feature, and a shared link to a feature must not open a
  // page whose title names a different one. The default feature needs no suffix: its label IS
  // the site's name, so `Eat Outside NYC · Eat Outside NYC` would be the alternative.
  useEffect(() => {
    const label = feature.identity.label;
    document.title = label === SITE_NAME ? label : `${label} · ${SITE_NAME}`;
  }, [feature]);

  // A tighter filter set — or a different feature — means the previously revealed page size
  // is meaningless, and so does an order carried over from a feature that has a different
  // vocabulary of orders.
  useEffect(() => {
    setRevealed(DEFAULT_VISIBLE_LIMIT);
    setSort(null);
  }, [filters, featureId]);

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

  /*
   * ANNOUNCING A FILTER CHANGE (WCAG 4.1.3 Status Messages, and 3.2.2 On Input).
   *
   * Picking a chip changes two lists at once — the map's contents and the list's — and
   * neither is a focus target, so a screen reader user gets no feedback that anything
   * happened unless something says so. This is that something.
   *
   * It is deliberately NOT wired to the map's bounds. Panning the map also changes the
   * count, and announcing every pan would train a screen-reader user to ignore the region
   * entirely, which is worse than having none. Only the visitor's own filter choice is
   * announced, which is exactly the change of context 3.2.2 asks to be described.
   */
  const [filterNotice, setFilterNotice] = useState('');
  const lastFilterKey = useRef('');
  const filterKey = `${featureId}|${filters.type}|${filters.borough}`;

  useEffect(() => {
    if (listing.datasetCount === 0) {
      setFilterNotice('');
      lastFilterKey.current = filterKey;
      return;
    }
    if (filterKey === lastFilterKey.current) return;
    lastFilterKey.current = filterKey;
    const count = formatPluralizedCount(listing.datasetCount, nouns.one, nouns.many);
    setFilterNotice(
      isFiltered(filters)
        ? `${count} match your filters across New York City.`
        : `${count} across New York City.`,
    );
  }, [filterKey, filters, listing.datasetCount, nouns]);

  const ready = data.status === 'ready' && controller !== null;
  const geoBusy = geo.status === 'locating';
  const inViewTotal = listing.total;

  return (
    <div className="eoy-app">
      {/* Everything behind the sheet, so `aria-modal` on the sheet is a true statement. */}
      <div className="eoy-app__body" inert={sheetOpen}>
        {/*
          THE FIRST FOCUSABLE THING ON THE PAGE, and a `<button>` on purpose. An anchor to
          `#eoy-place-list` would be worse twice over: the list carries `hidden` in map view,
          so the browser would try to focus a subtree that is not rendered, and the view
          underneath it would still be the map. There is no router here, so pressing this is
          an action on the page rather than navigation.

          `aria-controls` is the half that was missing, and it is the same relationship
          `SearchBox` already asserts: the id resolves to a real element in the DOM whether
          or not that element is currently shown, so the association survives the press. The
          target is the labelled `<section>` in `ShellList` — not the heading, which is
          where focus actually lands, because `aria-controls` names the region and the
          heading is inside it. The id is a literal here because the association spans two
          components; `tests/app-skip-control.test.tsx` resolves it against the live DOM, so
          a rename of the section cannot quietly break it.

          GATED ON `ready`, like the rail and Near me beside it, and for the same reason
          neither offers itself before there is a dataset. `ShellList` is not mounted until
          then, so offering the control earlier would mean an `aria-controls` pointing at
          nothing — a claim the DOM denies, which axe rates critical — and a "show the
          list" that shows nothing while hiding the map. The control is only true when the
          region it names exists.

          The name says "show" rather than "skip", because pressing this turns the map off
          and "skip" promises only a change of focus. The consequence is spelled out in the
          label rather than left to be inferred, since a screen-reader user cannot watch the
          map disappear — and it stays in the label rather than in an `aria-describedby`
          hint, because this control sits outside every landmark and axe's `region` rule
          exempts a button but not a bare text span dropped beside one.

          Thirty-four characters of label was the first attempt and it is nearly twice this:
          `.eoy-skip-link` is absolutely positioned with no width, so it sizes to its content
          and wraps at whatever the viewport is. At the 320px floor of WCAG 1.4.10 a longer
          label wraps to two lines, and a two-line pill lands on top of the wordmark — the
          one thing on this page a visitor is guaranteed to have already read. So the name is
          kept to one line at 320px, and `tests/app-skip-control.test.tsx` pins the two facts
          that matter (it names the list, and it says the map goes) rather than the wording.
        */}
        {ready ? (
          <button
            type="button"
            className="eoy-skip-link"
            aria-controls="eoy-place-list"
            onClick={() => {
              focusListAfterSwitch.current = true;
              setViewMode('list');
            }}
          >
            Show the list, not the map
          </button>
        ) : null}

        <header className="eoy-header">
          <div className="eoy-header__bar">
            <h1 className="eoy-wordmark">
              <span className="eoy-wordmark__mark" aria-hidden="true" />
              {SITE_NAME}
            </h1>

            {/*
              The feature switcher sits in its OWN row, below the search box and above the
              filter rail, rather than in the bar beside the wordmark. The bar is already
              wordmark + search + Near me, and at the 320px floor of WCAG 1.4.10 a fourth
              control there squeezes the SEARCH field to about 50px — the primary control
              becoming the narrowest thing in the header. A row of its own is 44px tall,
              scrolls rather than wraps, and is on screen in both views because the header
              is.
            */}
            {SearchSlot === null ? null : (
              <SearchSlot
                onPickArea={handlePickArea}
                onPickItem={handleSelect}
                {...(geocode === undefined ? {} : { geocode })}
              />
            )}

            <button
              type="button"
              className="eoy-pill eoy-pill--on-dark"
              onClick={geo.request}
              disabled={!ready || geoBusy}
              aria-describedby="eoy-nearme-hint"
            >
              <NearMeIcon size={16} />
              <span>{geoBusy ? 'Locating' : 'Near me'}</span>
            </button>
            <span className="eoy-visually-hidden" id="eoy-nearme-hint">
              Asks your browser for your position once. Your position is never stored and never
              added to the address of this page.
            </span>
          </div>

          <FeatureSwitcher
            features={features}
            selected={featureId}
            onSelect={handleSelectFeature}
            disabled={!ready}
          />

          {FilterSlot === null ? null : (
            <FilterSlot filters={filters} onChange={handleFilters} disabled={!ready} />
          )}

          {/* The only place a filter change is spoken. See the note above. */}
          <div
            className="eoy-visually-hidden"
            role="status"
            aria-live="polite"
            data-testid="filter-notice"
          >
            {filterNotice}
          </div>
        </header>

        <main className="eoy-stage">
          <div
            className="eoy-map"
            hidden={viewMode !== 'map'}
            ref={setContainer}
            tabIndex={-1}
            role="region"
            // The region's name describes the map that is actually on it, so it changes with
            // the feature. A screen-reader user arriving on `?mode=walk` is told what they
            // have open, not what the app was built to show.
            aria-label={copy.mapLabel}
            data-testid="map-canvas"
          />

          {/*
            The generic legend unless the feature brings its own. Where NYC Walks does: its
            swatches are rings, hollow rings and heavy-rimmed discs drawn from CSS custom
            properties in `src/index.css`, which the shell's three-shape vocabulary has no
            class for, and a flat colourless dot beside "Hollow ring with an x" would be
            worse than no swatch at all.
          */}
          {viewMode === 'map' && ready
            ? LegendSlot === null
              ? <ShellLegend legend={feature.legend} />
              : LegendSlot(feature.legend)
            : null}

          {/*
            THE MESSAGE STACK. The user-position chip, the basemap-loading chip and the
            geolocation notice can all be on screen at once, and each needs the other's
            space. Positioning them with three hand-tuned `top` offsets meant the first
            layout that put two of them side by side silently overlapped them at 320px, so
            they stack in normal flow instead and there is nothing to keep in sync.
            `pointer-events: none` on the column lets a pan or a drag pass through the gaps
            between messages and reach the map, which a full-width bar would have swallowed.
          */}
          <div className="eoy-messages">
            {ready && mapState.status === 'loading' ? <MapLoadingState /> : null}
            {ready && mapState.status === 'error' ? <MapErrorState error={mapState.error} /> : null}
            {userPosition !== null ? (
              <p className="eoy-user-chip">
                <span className="eoy-user-chip__dot" aria-hidden="true" />
                <span>Using your location</span>
                <button type="button" className="eoy-button--tight" onClick={geo.clear}>
                  Turn off
                </button>
              </p>
            ) : null}
            {/* Not gated on the view mode: a "permission declined" message must still be
                there when the visitor reads the list, because reading the list is the
                fallback the message itself points at. */}
            {geo.message !== null ? (
              <div className="eoy-notice" role="status">
                <p className="eoy-notice__text">{geo.message}</p>
                <button type="button" className="eoy-button--tight" onClick={geo.clear}>
                  Dismiss
                </button>
              </div>
            ) : null}
          </div>

          {data.status === 'loading' ? <DataLoadingState copy={copy.data.loading} /> : null}
          {data.status === 'error' ? (
            <DataErrorState copy={copy.data.failure} error={data.error} onRetry={data.retry} />
          ) : null}

          {ready ? (
            <ShellList
              visible={viewMode === 'list'}
              rows={listing.rows}
              total={inViewTotal}
              datasetCount={listing.datasetCount}
              filtered={listing.filtered}
              nouns={nouns}
              filtering={copy.filtering}
              selectedId={selectedId}
              revealed={revealed}
              headingRef={listHeadingRef}
              // Gated on `ready`, and the gate is a comment rather than a `disabled` prop
              // because `WalkSortControl` has no such prop on purpose: a disabled radio
              // invites the question the app cannot answer, and the right answer to "you
              // cannot order this list" is to not offer the ordering until there is a list
              // to order.
              {...(SortSlot === null || !ready
                ? {}
                : { sortControl: <SortSlot sort={sort} origin={userPosition} onChange={setSort} /> })}
              onRevealMore={() => setRevealed((value) => value + DEFAULT_VISIBLE_LIMIT)}
              onSelect={handleSelect}
              onZoomToAll={() => controller?.fitToResults(feature.extent(query))}
              onClearFilters={() => handleFilters(NO_FILTER)}
            />
          ) : null}
        </main>

        {ready ? (
          <footer className="eoy-bottom-bar">
            <div className="eoy-bottom-bar__inner">
              <p className="eoy-bottom-bar__count">
                <span className="eoy-bottom-bar__num">{inViewTotal.toLocaleString('en-US')}</span>
                <span className="eoy-bottom-bar__unit">in this area</span>
              </p>
              <ViewToggle
                mode={viewMode}
                onChange={setViewMode}
                listCount={inViewTotal}
                nouns={nouns}
              />
            </div>
          </footer>
        ) : null}
      </div>

      <UserLocationMarker controller={controller} position={userPosition} />

      {/*
        Two paths, and both are real. A feature that brings its own sheet keeps its own
        words in full — Eat Outside's is a licence type list, an address block, a seasonal
        note and a directions link — and one that does not gets `FeatureDetail` rendered
        generically. The chrome around whichever is chosen is the shell's, which is why the
        focus trap and `inert` are the same in both.
      */}
      {detail !== null && selectedId !== null
        ? SheetSlot === null
          ? (
              <ShellDetailSheet
                detail={detail}
                onClose={clearSelection}
                {...(viewMode === 'list' ? { onShowOnMap: () => setViewMode('map') } : {})}
              />
            )
          : (
              <SheetSlot
                id={selectedId}
                origin={userPosition}
                onClose={clearSelection}
                {...(viewMode === 'list' ? { onShowOnMap: () => setViewMode('map') } : {})}
              />
            )
        : null}
    </div>
  );
}
