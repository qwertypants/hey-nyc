/**
 * THE FEATURE REGISTRY — the seam between the application shell and a map feature.
 *
 * The shell owns the MapLibre instance, the basemap, the camera, geolocation, the URL
 * mirror and the mobile layout. A feature owns its data, its layers, its filters, its
 * legend, its list and its detail sheet. The shell never asks what a feature means; the
 * feature never reaches into the shell's state.
 *
 * WHY AN INTERFACE AND NOT A `switch`
 * -----------------------------------
 * The first draft of this feature was going to grow `if (mode === 'walk')` branches through
 * App.tsx, the controller and the map layers. That does not survive a third feature, and it
 * puts the two features' concerns in the same functions where they can disagree. Everything
 * here is deliberately small and total: a feature either answers every question below or it
 * does not compile.
 *
 * WHY A FEATURE IS NOT ALLOWED TO STEER THE CAMERA
 * -------------------------------------------------
 * Switching features preserves the viewport "when reasonable" (see `MapFeature.onEnter`).
 * That is a decision the SHELL makes, because only the shell knows whether the previous
 * camera is meaningful in the new feature's geography. A feature receives a controller it
 * may draw on; it is not handed `flyTo`, `fitBounds` or `jumpTo`, and `MapLibreLike` below
 * has no member that could aim the camera. The single `easeTo` on that interface is the one
 * documented exception and it is not a camera decision at all — see its comment.
 *
 * A feature's `id` is also its URL slug. `?mode=walk` and `?mode=eat` are the only two the
 * app advertises, and `readMode` in `src/lib/urlState.ts` is the single place that decides
 * what an unknown or absent slug means.
 *
 * THE THREE TYPE PARAMETERS, AND WHY THERE ARE THREE
 * ---------------------------------------------------
 *   TItem      what a row or a detail is resolved FROM. Erased by the shell, which renders
 *              formatted strings and never touches an item.
 *   TFilters   what this feature's filter value IS. Feature-scoped on purpose: see the long
 *              comment on `FeatureQuery`.
 *   TControls  what this feature's own React looks like. `null` by default, because a
 *              feature with no filter rail, no search box, no sort control, no custom legend
 *              and no custom sheet has nothing to declare and the shell must then render
 *              nothing for it rather than something empty.
 *
 * Public surface: every type below, and `AnyFeature`.
 */

import type { JSX } from 'react';
import type { MapBounds } from '../lib/bounds';
import type { Filters } from '../lib/filters';
import type { GeocodeOutcome, GeocodeResult } from '../lib/geocode';

/** A feature's stable identity. The slug is what appears in `?mode=`. */
export type FeatureId = 'eat' | 'walk';

/** Which of a feature's two datasets is on the map. Walk has two; eat has one. */
export type WalkLayerId = 'historical' | 'sensors';

export interface FeatureIdentity {
  readonly id: FeatureId;
  /** Visible name, e.g. "Where NYC Walks". Not a sentence. */
  readonly label: string;
  /** One line, shown as the switcher's description and the document title suffix. */
  readonly description: string;
  /** `NYC DOT` etc. Shown in the About/Data attribution. */
  readonly attribution: string;
}

/**
 * A legend is a list of swatches plus the caveat that makes the visualisation honest.
 *
 * The caveat is NOT optional. Pedestrian activity is measured at 114 screenline sites and 4
 * automated counters; a reader who sees 114 dots has to be told those are measurement
 * points, not a description of foot traffic between them. `note` is where that sentence
 * lives, and it is rendered inside the legend, not in a help page nobody opens.
 */
export interface LegendSwatch {
  readonly id: string;
  readonly label: string;
  /** Drives the swatch. Kept as a CSS colour so the legend and the layer cannot disagree. */
  readonly color: string;
  /** Screen-reader description of the SYMBOL, since colour is never the only channel. */
  readonly symbol: string;
}

export interface LegendConfig {
  readonly title: string;
  readonly swatches: readonly LegendSwatch[];
  /** The honesty sentence. Required — see the type comment. */
  readonly note: string;
  /** A control that opens the methodology doc. Optional but expected. */
  readonly aboutHref?: string;
}

/**
 * The singular and plural noun every count in the app is built from.
 *
 * Feature vocabulary, because "3 places" and "114 survey sites" are different claims about
 * different datasets and the shell has no business choosing between them. `formatPluralizedCount`
 * in `src/lib/format.ts` turns a count and one of these into a sentence; nothing else in the
 * app is allowed to hard-code a plural.
 */
export interface Nouns {
  readonly one: string;
  readonly many: string;
}

/** The feature's data, resolved. A feature is not usable until this is `ready`. */
export interface FeatureData<TItem> {
  readonly status: 'loading' | 'ready' | 'error';
  readonly items: readonly TItem[];
  readonly byId: ReadonlyMap<string, TItem>;
  readonly error: Error | null;
  readonly retry: () => void;
  /** Short provenance line: "Updated 3 days ago" / "Surveyed May 2026". */
  readonly provenance: string | null;
}

/**
 * One row of the list. The shell renders every one of these generically and never learns
 * what any of them means.
 *
 * The three optional-looking fields are not optional in the ways their names suggest, and the
 * distinction matters:
 *
 *   `badge`  null means the DATASET MAKES NO CLAIM about this item. Eat Outside has none, and
 *            inventing a category would be a claim its source does not make. Walk has one.
 *   `meta`   the feature's own words for what this row is. `null` is allowed, and then the
 *            row simply has two lines instead of three.
 *   `symbol` a CSS shape modifier the shell's own stylesheet knows — `disc`, `rimmed-disc`,
 *            `ring`. `null` means this feature draws its swatches itself, in which case the
 *            shape is in `meta` as words. It is never a colour: a colour cannot carry a shape.
 *   `distance` already formatted, or `null` for "the shell renders no distance element".
 *            Null is the normal case until the visitor asks for their position, and it is
 *            also right for a feature that puts the distance in its own `subtitle` — a
 *            second element saying it again would be noise, not emphasis.
 */
export interface FeatureRow {
  readonly id: string;
  readonly title: string;
  /** One line under the title. E.g. an address, or "Surveyed May 2026". */
  readonly subtitle: string;
  /** A short uppercase qualifier, e.g. "VERY BUSY" or "RISING". */
  readonly badge: string | null;
  readonly meta: string | null;
  readonly symbol: string | null;
  readonly distance: string | null;
  readonly lat: number;
  readonly lng: number;
}

/** How a feature's rows are ordered. Defined, not inferred — "most active" is a claim. */
export type WalkSort = 'nearby' | 'mostSurveyed' | 'mostChanged';

/**
 * Everything a feature needs to know about "what is being asked for right now".
 *
 * THE FILTER SHAPE IS THIS FEATURE'S, NOT THE APP'S. `TFilters` is a type parameter of
 * `MapFeature` rather than a fixed `Filters` here, and that is a deliberate refusal to
 * widen `src/lib/filters.ts`. `Filters` is `{ type, borough }`: two dimensions that exist
 * because NYC Open Data publishes them for `fpeh-f7ci`, with `'all'` as the absent value so
 * `?type=` can be omitted from the link. Widening it to accommodate a feature that has
 * neither dimension would make `parseUrlState` ambiguous, weaken the exhaustiveness the eat
 * rail and the map filter expression both depend on, and put a union of unrelated dimensions
 * into a type the URL is parsed from. So a feature declares the filter value it can accept:
 * Eat Outside declares `Filters`, and Where NYC Walks declares a shape it does not constrain,
 * because it has no dimensions to filter by and says so with `controls.filters === null`
 * rather than with a type.
 *
 * The shell erases `TFilters` to `unknown` in `AnyFeature` and holds the concrete value
 * itself, which it has to anyway: the URL is written from one place and `Filters` is what
 * `src/lib/urlState.ts` parses.
 */
export interface FeatureQuery<TFilters> {
  readonly filters: TFilters;
  /**
   * The map's visible extent, or `null` before the map has reported one. `null` means
   * "no extent filter" and never "nothing is visible" — an empty list for the first frame
   * after load is a lie about the map.
   */
  readonly bounds: MapBounds | null;
  /** The visitor's own fix, and the only legal origin for a distance. */
  readonly origin: LatLngLike | null;
  /**
   * `null` means the shell has not chosen an order, and the feature then uses its own
   * default — which it must also show as selected in whatever control it supplies, or the
   * control is describing a list that is not the one on screen.
   */
  readonly sort: WalkSort | null;
}

export interface FeatureRowsQuery<TFilters> extends FeatureQuery<TFilters> {
  /** The page cap. The shell's, because the shell owns the "revealed" count. */
  readonly limit: number;
}

export interface FeatureRows {
  /** The page: at most `limit` rows. */
  readonly rows: readonly FeatureRow[];
  /** The untruncated size of the same set, so "60 of 1,432" can be honest. */
  readonly total: number;
  /** Matches in the whole dataset under the active filters, ignoring the extent. */
  readonly datasetCount: number;
  readonly filtered: boolean;
}

/** What a feature tells the shell while it is mounted. */
export interface FeatureHandlers {
  readonly onSelect: (id: string) => void;
  readonly onClearSelection: () => void;
  readonly onError: (error: Error) => void;
}

/**
 * THE LIVE-STATE CHANNEL. Three members, and NOT a `mount(map, handlers)` signature.
 *
 * The argument for the signature is that it is one fewer member. The argument against it is
 * that `mount` already carries a promise — "draw, idempotently, and remove your own layers
 * before adding them" — and `handlers` is not part of drawing. Every feature that answers
 * `mount` idempotently (Eat Outside and Where NYC Walks both do) returns early when it is
 * already mounted, so a second `mount(map, handlers)` carrying a fresh set of closures would
 * re-enter that early return and silently drop them: a feature would keep calling the
 * handlers from the render that first mounted it, which is a closure over a stale
 * `selectedId`. Pushing handlers down a separate channel is what lets the shell replace them
 * on every commit without touching a single layer, and it is why the shell's mount effect can
 * stay keyed on `[controller, mapStatus, feature]` and nothing else.
 *
 * The three are grouped rather than flattened onto the feature because they are one idea —
 * "state that is not data" — and because a group is the only place a reader can be reminded
 * that none of the three is allowed to redraw anything.
 *
 * The feature owns the truth. The controller holds the mirror the URL and the sheet are read
 * from, so the shell pushes down and pulls up and neither side can be stale by more than a
 * frame.
 */
export interface FeatureState<TFilters> {
  /** Applies a filter change. While the map sits still. MUST NOT redraw. */
  setFilters(filters: TFilters): void;
  /** Applies a selection change. While the map sits still. MUST NOT redraw. */
  setSelectedId(id: string | null): void;
  /** Where a feature REPORTS a click. Replaced freely; never redraws. */
  setHandlers(handlers: FeatureHandlers): void;
}

/** A card's two sentences. The shell owns the card, the role and the retry button. */
export interface StateCopy {
  readonly title: string;
  readonly body: string;
}

/**
 * THE FEATURE'S OWN WORDS (gap 6). The shell renders the map region, the `role`, the loading
 * card, the `role="alert"`, the retry button and the shimmer; every sentence inside them is
 * here, because a page about pedestrian counts that says "The place list did not load" is
 * lying about what failed.
 */
export interface FeatureCopy {
  /** `aria-label` for the map region, which is `role="region"` and must describe its map. */
  readonly mapLabel: string;
  readonly data: {
    readonly loading: StateCopy;
    readonly failure: StateCopy;
  };
  /**
   * The empty state's two sentences about the FILTERS, in the feature's own words: what the
   * visitor is filtering by, and what to try next. "dining type and borough" / "Try a
   * different dining type, or a different borough" here; a feature with different
   * dimensions says so, rather than being told to try a dining type it has never heard of.
   */
  readonly filtering: {
    readonly dimensions: string;
    readonly retryHint: string;
  };
}

export interface FilterSlotContext<TFilters> {
  readonly filters: TFilters;
  readonly onChange: (filters: TFilters) => void;
  /** True until the active feature's data is resolved, so a count can never show a stale 0. */
  readonly disabled: boolean;
}

export interface SearchSlotContext {
  /**
   * Frames a geocoded place. The shell owns the camera, so the shell owns this — and it is
   * the real `GeocodeResult` rather than a narrowed shape, because the geocoder is shell
   * infrastructure and every search control takes the same result.
   */
  readonly onPickArea: (result: GeocodeResult) => void;
  /** Selects and flies. */
  readonly onPickItem: (id: string) => void;
  /**
   * The geocoder, injected by the shell. Present only when a test has supplied one, which
   * is how the app is rendered in jsdom without ever reaching the network.
   */
  readonly geocode?: (query: string) => Promise<GeocodeOutcome>;
}

export interface SortSlotContext {
  /** The shell's current order, or `null` before the visitor has chosen one. */
  readonly sort: WalkSort | null;
  /** The visitor's fix. The only legal reason a `nearby` sort can exist. */
  readonly origin: LatLngLike | null;
  readonly onChange: (sort: WalkSort) => void;
}

export interface SheetSlotContext {
  readonly id: string;
  readonly onClose: () => void;
  /** Rendered as a secondary action only when the list is covering the map. */
  readonly onShowOnMap?: () => void;
  readonly origin: LatLngLike | null;
}

/**
 * THE FEATURE'S OWN CONTROLS (gap 5). Every slot is nullable, and a `null` slot means the
 * shell renders nothing there — no filter rail, no search box, no sort control, no custom
 * legend, no custom sheet — rather than something empty.
 *
 * This is the one member that cannot be expressed without naming React, which is why it is a
 * type parameter defaulted to `null` rather than a field: a feature with no controls
 * declares nothing and the shell's TypeScript still knows it has none. `import type { JSX }`
 * is a TYPE-only import, so the registry still pulls in no runtime dependency and no map
 * engine — the same trade `MapLibreLike` below makes, for the same reason.
 *
 * Two slots are not about a feature's data at all, and are here for the same reason the
 * others are: a feature whose swatch shapes need a stylesheet of its own brings its own
 * legend, and a feature whose sort definitions are claims about its own measurements brings
 * its own control that can print them. The shell can draw a list row, a generic facts list
 * and a generic bar-per-survey chart; it cannot decide that "Busiest" means the most recent
 * survey's total rather than a lifetime average.
 */
export interface FeatureControls<TFilters> {
  readonly filters: ((context: FilterSlotContext<TFilters>) => JSX.Element | null) | null;
  readonly search: ((context: SearchSlotContext) => JSX.Element) | null;
  readonly sort: ((context: SortSlotContext) => JSX.Element | null) | null;
  /** A feature with no stylesheet of its own leaves this `null` and the shell draws `LegendConfig`. */
  readonly legend: ((legend: LegendConfig) => JSX.Element) | null;
  /**
   * A feature that brings its own sheet keeps its own words in full; `null` means the shell
   * renders `FeatureDetail` generically, which is enough for a feature whose detail really
   * is a title, a headline, some facts and a caveat.
   */
  readonly sheet: ((context: SheetSlotContext) => JSX.Element | null) | null;
}

export interface MapFeature<TItem = unknown, TFilters = unknown, TControls = null> {
  readonly identity: FeatureIdentity;

  /** GAP 1. A feature is not usable until its data is `ready`, so the data is a member. */
  readonly data: FeatureData<TItem>;

  /** GAP 2. The live-state channel. See `FeatureState`. */
  readonly state: FeatureState<TFilters>;

  /**
   * Draw. Called after the shell has the MapLibre map and before the feature is shown, and
   * again whenever the feature's own data changes.
   *
   * MUST be idempotent and MUST remove its own layers before adding them. Switching
   * eat -> walk -> eat -> walk must not leave two copies of a layer or two copies of an
   * event listener; `tests/feature-switching.test.tsx` switches repeatedly and asserts it.
   */
  mount(map: MapLibreLike): void;

  /**
   * Undraw. Every layer and every listener this feature added, gone. Called on switch-away
   * and on unmount. The shell asserts afterwards that no layer of this feature's remains.
   */
  unmount(map: MapLibreLike): void;

  /** Called after mount, with the viewport the shell is holding. Preserve it by default. */
  onEnter(map: MapLibreLike, view: MapViewLike): void;

  /**
   * Called before unmount, so a feature can persist anything it needs to come back
   * instantly. Data is cached in memory by the shell; this is only for view state.
   */
  onLeave?(map: MapLibreLike): void;

  readonly legend: LegendConfig;

  /** GAP 4. The feature's own count vocabulary. See `Nouns`. */
  readonly nouns: Nouns;

  /** GAP 6. The sentences the shell's cards and the map region are made of. See `FeatureCopy`. */
  readonly copy: FeatureCopy;

  /** GAP 5. `null` when this feature contributes no controls of its own. */
  readonly controls: TControls;

  /**
   * GAP 3. The list: "what is in the area the map is showing, under the filters, in this
   * order, up to the page cap", and the counts that let the shell say so honestly.
   */
  rows(query: FeatureRowsQuery<TFilters>): FeatureRows;

  /** GAP 3, for "zoom to everything that matches". */
  extent(query: FeatureQuery<TFilters>): MapBounds | null;

  /**
   * GAP 3, for "fly to this thing". `null` when the active feature has no such item, which
   * is how a selection left over from the other feature is refused rather than flown to.
   */
  positionOf(id: string): LatLngLike | null;

  /**
   * The detail sheet's content, as already-formatted strings. The shell owns the sheet
   * chrome, the focus trap and the close button; a feature owns its words.
   *
   * Returns null for an id this feature does not have, which is how a selection left over
   * from the other feature is cleared rather than rendered as an empty sheet.
   */
  detail(id: string): FeatureDetail | null;
}

export interface FeatureDetail {
  readonly title: string;
  /** The headline qualifier, e.g. "BUSY" or "SURVEYED MAY 2026". */
  readonly headline: string;
  /** Label/value rows. Values are pre-formatted so no feature formats in two places. */
  readonly facts: ReadonlyArray<{ readonly label: string; readonly value: string }>;
  /**
   * A series to draw, if the feature has one. Discrete surveys must set
   * `discrete: true` so the chart does not draw a continuous line between two points the
   * source never measured between.
   */
  readonly series?: FeatureSeries;
  /** The honesty sentence for THIS item, e.g. "Last reading 14 hours ago". */
  readonly caveat: string | null;
}

export interface FeatureSeries {
  readonly title: string;
  readonly points: ReadonlyArray<{ readonly label: string; readonly value: number | null }>;
  /** True when the points are separate measurements, not a continuous series. */
  readonly discrete: boolean;
  readonly unit: string;
}

/**
 * The shell's view of a feature, with the item type erased and the filter type erased too:
 * the shell renders `FeatureRow` and `FeatureDetail` and never touches an item, and it holds
 * one `Filters` value of its own because the URL is written from one place. The controls are
 * NOT erased — they are the shell's own `FeatureControls<Filters>`, because a filter rail
 * writes shell filter state and a `null` slot has to stay statically `null` for the shell to
 * be able to skip rendering it.
 */
export type AnyFeature = MapFeature<unknown, unknown, FeatureControls<Filters>>;

// ---------------------------------------------------------------------------
// Structural types, so a feature module never imports MapLibre.
// ---------------------------------------------------------------------------

/** What MapLibre's `on` returns, and the only way a listener comes off again. */
export interface MapSubscription {
  unsubscribe(): void;
}

/** The options object `queryRenderedFeatures` takes as its second argument. */
export interface QueryRenderedOptions {
  /**
   * `string[] | Set<string>` and NOT `readonly string[]`, because that is MapLibre's own
   * type and a `readonly` array is not assignable to it. A structural interface has to be a
   * SUPERTYPE of the real thing, and a readonly array is a subtype.
   */
  readonly layers?: string[] | Set<string>;
}

/** A hit from `queryRenderedFeatures`: enough to read an id and, for a cluster, its centre. */
export interface MapRenderedFeature {
  readonly geometry?: { readonly type?: string; readonly coordinates?: readonly number[] } | null;
  readonly properties?: Record<string, unknown>;
}

/**
 * The sliver of the MapLibre surface a feature is allowed to touch.
 *
 * Deliberately not `import type { Map } from 'maplibre-gl'`. The registry is imported by
 * App.tsx, which is rendered by tests in jsdom with a fake controller; pulling the real
 * MapLibre types in here would make the whole component tree depend on a WebGL engine it
 * never instantiates. This mirrors why `createMapController` is a required prop rather than
 * a default: the engine binding stays in one place.
 *
 * Every member below is declared so that a REAL `MapLibreMap` satisfies it, and that is a
 * checked fact rather than a hope: `tests/registry.test.ts` hands a `MapLibreMap`-shaped
 * object to a function that returns `MapLibreLike`, which fails to COMPILE the moment a
 * member here is missing, narrowed, or no longer a supertype of the engine's. It used to be
 * the other way round, and the cost of the difference was two `as unknown as` casts at the
 * engine boundary and one widening interface in `src/features/eat/eatMap.ts`.
 *
 * Two members are the reason the interface was unusable before, and both are about hit
 * testing rather than drawing:
 *
 *   - `on` takes three arguments, and the middle one is the layer a listener is scoped to. A
 *     per-layer hover cursor is the only way to say "this layer is a point you can click"
 *     without a hit test on every pointer move.
 *   - `queryRenderedFeatures` takes `{ layers }` as its second argument. Asking "what is
 *     under the pointer" SCOPED TO THIS FEATURE'S OWN LAYERS is the only correct way to hit
 *     test, because the map is shared: a later feature's layers may be sitting where an
 *     earlier feature's were.
 *
 * One member is NOT an overload set, and the reason is worth writing down because it is
 * counter-intuitive. MapLibre's `on` has four overloads — two of which take three arguments
 * for a layer-scoped listener — and the obvious fix for "a real Map will not assign to my
 * two-argument `on`" is to declare an overload set too. That does not work: TypeScript
 * relates an overloaded TARGET to a source by pairing signature N with signature N and
 * comparing ARITY first, so the target's two-argument signature is checked against the
 * source's three-argument one and reported as "Target signature provides too few arguments".
 * Adding a broad third signature to the target does not rescue it either, for the same
 * reason. So this is ONE signature with the layer id and the handler in a union and the
 * handler optional, which is a genuine supertype of all four of MapLibre's, and which every
 * call site below reads exactly as it reads in MapLibre's own documentation:
 *
 *   map.on('click', handler);
 *   map.on('mouseenter', layerId, handler);
 *
 * `on` returns a `MapSubscription` rather than `void`, because that is the only handle a
 * layer-scoped listener can be detached with — `off` can do it too, but holding the
 * subscription is what makes "detach exactly what I attached" checkable rather than a matter
 * of remembering the same function reference. The string[] form is here because MapLibre
 * accepts a list of layer ids and a structural interface must stay a supertype.
 */
export interface MapLibreLike {
  addSource(id: string, source: unknown): void;
  getSource(id: string): unknown;
  removeSource(id: string): void;
  addLayer(layer: unknown, before?: string): void;
  removeLayer(id: string): void;
  getLayer(id: string): unknown;
  setFilter(layerId: string, filter: unknown): void;
  on(
    event: string,
    layerIdOrHandler: string | string[] | ((event: never) => void),
    handler?: (event: never) => void,
  ): MapSubscription;
  off(
    event: string,
    layerIdOrHandler: string | string[] | ((event: never) => void),
    handler?: (event: never) => void,
  ): void;
  queryRenderedFeatures(
    point: unknown,
    options?: QueryRenderedOptions,
  ): readonly MapRenderedFeature[];
  getCanvas(): { style: { cursor: string } };
  /**
   * The one camera-adjacent member, and the one exception to the rule at the top of this
   * file. A clustered point layer has to answer "what zoom does this cluster dissolve at",
   * and that number comes out of the supercluster index THIS feature built — the feature is
   * not deciding where to look, it is reading its own data back. Everything that IS a camera
   * decision (`flyTo`, `fitBounds`, `jumpTo`) is absent, and the shell keeps the camera.
   */
  easeTo(options: unknown): unknown;
}

export interface MapViewLike {
  readonly lat: number;
  readonly lng: number;
  readonly zoom: number;
}

export interface LatLngLike {
  readonly lat: number;
  readonly lng: number;
}
