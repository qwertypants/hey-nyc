/**
 * THE TWO LAYER SHAPES EAT OUTSIDE BUILDS, checked locally.
 *
 * This file used to be the one widening in the feature tree: `MapLibreLike` was declared
 * narrower than what a clustered point layer actually needs, so `EatMap` re-declared
 * `queryRenderedFeatures`'s `{ layers }` argument, `on`'s three-argument form, `on`'s return
 * value, `easeTo` and the rendered feature's `geometry`, and `asEatMap` cast between the two
 * with `as unknown as`.
 *
 * All five of those are now in `src/features/registry.ts`, because a real `MapLibreMap` has
 * all five and the seam has to accept the real map. So there is nothing left to widen: the
 * feature draws on `MapLibreLike` directly, and no module under `src/features/` imports
 * `maplibre-gl` to find out what the engine's types are.
 *
 * What is left is the other half of the same trade. Declaring the seam structurally means a
 * layer specification is `unknown` at the seam, so the four fields this file sets are
 * declared here instead of being imported from `maplibre-gl` — four small interfaces rather
 * than four imported types, and a layer the engine rejects is a runtime error the app already
 * surfaces through `MapErrorState`.
 *
 * Public surface:
 *   BaseLayerSpec, CircleLayerSpec, SymbolLayerSpec, LayerSpec
 */

export interface BaseLayerSpec {
  readonly id: string;
  readonly source: string;
  readonly filter?: unknown;
  readonly minzoom?: number;
}

export interface CircleLayerSpec extends BaseLayerSpec {
  readonly type: 'circle';
  readonly paint?: Readonly<Record<string, unknown>>;
}

export interface SymbolLayerSpec extends BaseLayerSpec {
  readonly type: 'symbol';
  readonly layout?: Readonly<Record<string, unknown>>;
  readonly paint?: Readonly<Record<string, unknown>>;
}

export type LayerSpec = CircleLayerSpec | SymbolLayerSpec;
