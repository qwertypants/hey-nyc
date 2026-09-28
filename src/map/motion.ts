/**
 * INTEGRATION NOTES (src/map/motion.ts)
 *
 * The user's motion preference, read in one place, and the one place a camera move's animation
 * is decided. Every camera move in `src/map` goes through `motionFor`, so honouring
 * `prefers-reduced-motion` is a property of the map rather than a decision each call site can
 * forget.
 *
 * Why this has to exist at all: every motion in this app is imperative JavaScript driving the
 * MapLibre camera. `src/index.css` declares no `transition` and no `animation`, so its
 * `@media (prefers-reduced-motion: reduce)` block has no CSS motion to switch off. The app was
 * honouring the preference for a class of animation it does not have, and ignoring it for the
 * one class it does.
 *
 * Read at the point of use rather than cached in a module constant, deliberately. A constant is
 * evaluated before a test can stub `matchMedia`, and it would freeze the answer for the life of
 * the page, so a visitor who switches the setting on in the OS would keep getting the old
 * behaviour. One `matchMedia` call per camera move is not worth optimising away.
 *
 * MapLibre reads the same query for itself — `browser.prefersReducedMotion` in
 * `node_modules/maplibre-gl/src/util/browser.ts` — and honours it, unless the call site passes
 * `essential: true`, which is its word for "ignore the user's setting". That is why
 * `CameraAnimation` has two fields and why `motionFor` sets both.
 *
 * Public surface:
 *   DEFAULT_CAMERA_DURATION_MS, CameraAnimation
 *   prefersReducedMotion(): boolean
 *   motionFor(requested: CameraAnimation): CameraAnimation
 */

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

/** The camera animation every move in `src/map` asks for, in one constant. */
export const DEFAULT_CAMERA_DURATION_MS = 480;

/** How long a camera move would animate for, and whether it insists on doing so. */
export interface CameraAnimation {
  readonly duration: number;
  readonly essential: boolean;
}

export function prefersReducedMotion(): boolean {
  // A `typeof` guard rather than a try/catch: a server render, a browser without media queries
  // and a jsdom run without the test stub all reach this line, and the default for all three is
  // the same one MapLibre itself uses (`browser.prefersReducedMotion` returns false when
  // `matchMedia` is absent).
  if (typeof globalThis.matchMedia !== 'function') return false;
  return globalThis.matchMedia(REDUCED_MOTION_QUERY).matches;
}

/**
 * The animation a camera move actually gets.
 *
 * `essential` is the half that decides the outcome, and the reason nothing in `src/map` passes
 * it as `true` by default is specific: in MapLibre it does not mean "this move is important",
 * it means "override the user's reduced-motion setting". Both `easeTo` and `flyTo` branch on
 * `!options.essential && browser.prefersReducedMotion`, and `fitBounds` reaches both — it
 * forwards to `flyTo` unless `linear` is set. So a default of `true` did not merely fail to
 * honour the preference, it instructed MapLibre to ignore it.
 *
 * `duration: 0` is the half that guarantees the result. `essential: false` alone leaves the
 * outcome to an internal we do not control, and `duration: 0` alone still routes the move
 * through MapLibre's easing machinery rather than a jump. Together:
 *
 *   preference off  -> the call site's own numbers, unchanged.
 *   preference on   -> `duration: 0` AND `essential: false`, so MapLibre takes its own no-motion
 *                      path (`jumpTo` from `flyTo`, `duration = 0` from `easeTo`) and could not
 *                      animate for a frame even if `essential` were reintroduced above us.
 *
 * A caller that asks for `essential: true` is deliberately overruled while the preference is on.
 * Nothing in this app has an animation the user cannot do without: every move is navigation to a
 * place they chose, and the destination is identical either way.
 */
export function motionFor(requested: CameraAnimation): CameraAnimation {
  if (!prefersReducedMotion()) return requested;
  return { duration: 0, essential: false };
}
