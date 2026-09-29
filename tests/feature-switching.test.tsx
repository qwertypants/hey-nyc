/**
 * SWITCHING FEATURES MUST NOT ACCUMULATE ANYTHING.
 *
 * The shell's central promise, from `docs/where-nyc-walks.md`: `eat -> walk -> eat -> walk`
 * leaves the map in the state one switch would have left it in. Not a similar state — the
 * same one. Everything below is an OBSERVABLE consequence of that, read off the fakes rather
 * than off the React tree, because the failure modes are all invisible in a screenshot:
 *
 *   - a layer left behind, so the same pins are drawn twice and the second copy is a ghost
 *     nobody can select
 *   - an event listener left behind, so one click is handled by two features and the second
 *     one wins an argument nobody is having
 *   - a selection from the other feature, rendered as an empty sheet or, worse, as a real one
 *   - a filter carried across, so `?borough=Queens` describes a filter on a map that has no
 *     borough dimension
 *   - a second WebGL context, because the map was torn down and rebuilt instead of having its
 *     layers swapped
 *   - a second network request, because the feature cache is per-render rather than per-app
 *
 * The fakes are what make these countable. `tests/helpers/fakeMap.ts` now answers
 * `removeLayer`/`removeSource` (and throws when asked to remove something that is not there,
 * so a feature that tears down twice fails loudly), reports its layer and source ids, its
 * LIVE listener count and its `queryRenderedFeatures` calls; `tests/helpers/fakeController.ts`
 * can hand out that map (`withMap: true`) and records how many times the app asked for a
 * controller at all. `tests/feature-switching.test.tsx` is the first consumer of both.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderApp } from './helpers/render';
import { resetWalkCache } from '../src/data/walk/load';
import { ShellDetailSheet } from '../src/features/shell/ShellDetailSheet';
import type { FeatureDetail } from '../src/features/registry';
import { MIDTOWN_BOUNDS } from './helpers/fixtures';

const EAT = 'eoy-0000000000a1'; // KATZ S DELICATESSEN
const WALK_OPTION = /Where NYC Walks/;
const EAT_OPTION = /Eat Outside NYC/;

/** The four artifacts `src/data/walk/load.ts` asks for, by path. */
const WALK_ARTIFACTS = [
  'data/walk/historical-locations.geojson',
  'data/walk/sensors.geojson',
  'data/walk/historical-patterns.json',
  'data/walk/latest.json',
];

/** The switcher is the only place a feature is chosen, and it is a radiogroup. */
function switcher(): HTMLElement {
  return screen.getByTestId('feature-switcher');
}

function option(name: RegExp): HTMLElement {
  return within(switcher()).getByRole('radio', { name });
}

async function goTo(user: ReturnType<typeof userEvent.setup>, name: RegExp): Promise<void> {
  await user.click(option(name));
}

/**
 * Switching TO walk is a request, and the switcher is disabled for as long as the active
 * feature has nothing to show — which is the correct behaviour, and means a test cannot click
 * back until the load has answered. So every test that switches to walk waits for its LEGEND.
 *
 * The legend rather than the list heading, and the reason is the fixtures: the fake map
 * reports `MIDTOWN_BOUNDS`, which contains three Eat Outside fixtures and none of the walk
 * ones, so walk's honest answer at that camera is an empty list. The legend note is the
 * sentence that can only be on screen if the real feature loaded, drew its layers and
 * rendered its own words.
 */
async function goToWalk(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await goTo(user, WALK_OPTION);
  await screen.findByText(/shown only where NYC DOT measured it/i);
}

/** An extent every walk fixture is inside, for the tests that want to see its list. */
const WALK_BOUNDS = { west: -74.2, south: 40.6, east: -73.7, north: 40.9 };

/**
 * WAIT FOR THE FIRST FEATURE TO HAVE DRAWN, not merely to have loaded.
 *
 * Neither of the obvious signals is one. The bottom-bar count renders as soon as the
 * dataset resolves, which is commits before `feature.mount(map)`; and the controller being
 * non-null is no better, because `useActiveFeature` stores it in a different effect from
 * the one that calls `mount`. So a test that switched straight after either could observe a
 * map with no layers — the exact failure this file exists to catch, appearing in the test
 * meant to rule it out. It reproduced about one run in eight, only under the full suite,
 * where the extra scheduling pressure widens the gap.
 *
 * The map's own layer list is the honest signal, because "eat has drawn something" is
 * precisely what these tests are about. No timeout fudge: a feature that fails to mount
 * should hang here and say so, not proceed to assert on an empty map.
 */
async function waitForEatDrawn(app: ReturnType<typeof renderApp>): Promise<void> {
  await waitFor(() => {
    const map = app.controller().map();
    if (map === null) throw new Error('the test needs withMap: true');
    if (map.layerIds().length <= 1) {
      throw new Error(`eat has not drawn yet (layers: ${map.layerIds().join(', ') || 'none'})`);
    }
  });
}

/** `SURVEY_RISING`'s name — the fixture site selected in the sheet test below. */
const SURVEY_SITE = '82 Street at 37th Avenue';

describe('switching features', () => {
  beforeEach(() => {
    // `loadWalkOnce` memoises its promise at module level, exactly as the eat loader does,
    // and that memoisation is half of what this file is asserting — so it has to start empty
    // for every test.
    resetWalkCache();
  });

  it('reuses ONE map: same container, one controller, ever', async () => {
    const user = userEvent.setup();
    const app = renderApp({ withMap: true });
    await waitForEatDrawn(app);

    const container = screen.getByTestId('map-canvas');
    const firstMap = app.controller().map()?.map;
    expect(firstMap).toBeDefined();
    expect(app.createCount()).toBe(1);

    for (const name of [WALK_OPTION, EAT_OPTION, WALK_OPTION, EAT_OPTION]) {
      await goTo(user, name);
    }

    // The same DOM node the map was created into, still.
    expect(screen.getByTestId('map-canvas')).toBe(container);
    // One controller, and it was never destroyed: a teardown would mean a second WebGL
    // context and a visible flash of empty basemap between the two features.
    expect(app.createCount()).toBe(1);
    expect(app.controller().calls.destroy).not.toHaveBeenCalled();
    expect(app.controller().isDestroyed()).toBe(false);
    // The same MapLibre instance, not merely the same container.
    expect(app.controller().map()?.map).toBe(firstMap);
  });

  it('leaves exactly one set of layers on the map, however many times you switch', async () => {
    const user = userEvent.setup();
    const app = renderApp({ withMap: true });
    await waitForEatDrawn(app);

    const map = app.controller().map();
    if (map === null) throw new Error('this test needs withMap: true');

    const eatLayers = map.layerIds();
    const eatSources = map.sourceIds();
    // Eat Outside draws a source and six layers; if that is not what is on the map, the
    // feature never mounted and the rest of this file would be asserting on nothing.
    expect(eatLayers.length).toBeGreaterThan(1);
    expect(eatSources).toEqual(['eoy-locations']);

    await goToWalk(user);
    const walkLayers = map.layerIds();
    const walkSources = map.sourceIds();

    // Switching replaced the layers rather than adding to them: the outgoing feature's ids
    // are gone and the incoming feature's are the only ones left. And the incoming feature
    // really drew something — a switch to a feature with no layers is the "114 dots is
    // empty" failure this whole file exists to catch.
    expect(walkLayers.length).toBeGreaterThan(1);
    expect(walkLayers.every((id) => id.startsWith('wnyc-'))).toBe(true);
    expect(walkSources).toEqual(['wnyc-historical', 'wnyc-sensors']);

    // Back, and forward again: one switch and N switches must be indistinguishable.
    for (const name of [EAT_OPTION, WALK_OPTION, EAT_OPTION, WALK_OPTION]) {
      await goTo(user, name);
    }
    await screen.findByText(/shown only where NYC DOT measured it/i);
    expect(map.layerIds().slice().sort()).toEqual(walkLayers.slice().sort());
    expect(map.sourceIds()).toEqual(walkSources);
  });

  it('leaves exactly one set of listeners on the map, however many times you switch', async () => {
    const user = userEvent.setup();
    const app = renderApp({ withMap: true });
    await waitForEatDrawn(app);

    const map = app.controller().map();
    if (map === null) throw new Error('this test needs withMap: true');

    // Counted LIVE, not cumulatively, so a leak shows as a number that only ever goes up.
    // The two features legitimately differ — Eat Outside hit-tests three hoverable layers
    // with a mouseenter and a mouseleave each, Where NYC Walks has one click handler and no
    // hover — so the comparison is per feature: one switch must reach the same number as N
    // switches to the same feature.
    const onEat = map.listenerCount();
    const eatQueries = map.queries().length;
    expect(onEat).toBeGreaterThan(1);

    await goToWalk(user);
    const onWalk = map.listenerCount();
    expect(onWalk).toBeLessThan(onEat);

    for (const name of [EAT_OPTION, WALK_OPTION, EAT_OPTION, WALK_OPTION]) {
      await goTo(user, name);
    }
    await screen.findByText(/shown only where NYC DOT measured it/i);
    expect(map.listenerCount()).toBe(onWalk);

    await goTo(user, EAT_OPTION);
    expect(map.listenerCount()).toBe(onEat);
    // And nothing was hit-tested against layers that are not on the map: one switch to walk
    // and back adds no queries, because a query is only ever made by a click and this test
    // never clicks the map.
    expect(map.queries().length).toBe(eatQueries);
  });

  it('keeps the camera, and does not resize the map, on a switch', async () => {
    const user = userEvent.setup();
    const app = renderApp({ withMap: true });
    await waitForEatDrawn(app);

    // Pan somewhere specific, so "the viewport was preserved" is a claim about a value and
    // not about a default.
    act(() => {
      app.controller().setBounds(MIDTOWN_BOUNDS, { lat: 40.7447, lng: -73.9924, zoom: 14.25 });
    });
    const view = { ...app.controller().getState().view };
    const resizes = app.controller().calls.resize.mock.calls.length;
    const flights = [...app.controller().calls.flyTo.mock.calls, ...app.controller().calls.fitTo.mock.calls];

    await goTo(user, WALK_OPTION);
    await goTo(user, EAT_OPTION);

    expect(app.controller().getState().view).toEqual(view);
    // A switch is a layer swap, not a camera move: no `flyTo`, no `fitTo`, and no resize
    // either, because the header does not change height when the feature does.
    expect([...app.controller().calls.flyTo.mock.calls, ...app.controller().calls.fitTo.mock.calls]).toEqual(flights);
    expect(app.controller().calls.resize.mock.calls.length).toBe(resizes);
  });

  it('clears a selection the incoming feature cannot resolve, in both directions', async () => {
    const user = userEvent.setup();
    const app = renderApp({ withMap: true });
    await waitForEatDrawn(app);

    // Selected in eat, from the map rather than the list.
    act(() => {
      app.controller().selectFromMap(EAT);
    });
    expect(await screen.findByTestId('detail-sheet')).toHaveTextContent('KATZ S DELICATESSEN');
    // `eoy-` is Eat Outside's id prefix and no other feature's, so walk cannot resolve it.
    expect(screen.getByTestId('map-canvas')).toBeVisible();

    await goToWalk(user);

    // Gone from the shell, gone from the map, gone from the link.
    await waitFor(() => {
      expect(app.controller().getState().selectedId).toBeNull();
    });
    expect(screen.queryByTestId('detail-sheet')).not.toBeInTheDocument();
    expect(window.location.search).not.toContain('sel=');
    // And the background is interactive again, which is what `inert` was standing in for.
    expect(document.querySelector('.eoy-app__body')?.hasAttribute('inert')).toBe(false);

    // Coming back does NOT restore it. The selection belonged to the feature that was
    // showing, and a feature that is not showing has no business remembering it.
    await goTo(user, EAT_OPTION);
    await waitFor(() => {
      expect(app.controller().getState().selectedId).toBeNull();
    });
    expect(screen.queryByTestId('detail-sheet')).not.toBeInTheDocument();
  });

  it('does not carry one feature\'s filters into the other, and keeps each feature\'s own', async () => {
    const user = userEvent.setup();
    const app = renderApp({ withMap: true });
    await waitForEatDrawn(app);

    await user.click(within(screen.getByTestId('filter-rail')).getByRole('radio', { name: /^Queens/ }));
    expect(app.controller().getState().filters).toEqual({ type: 'all', borough: 'Queens' });
    expect(window.location.search).toContain('borough=Queens');

    await goToWalk(user);

    // Walk has no borough dimension, so the link must not describe one: a `borough` in the
    // query string of a map that cannot be filtered by borough is a filter the visitor can
    // neither see nor undo.
    expect(window.location.search).toContain('mode=walk');
    expect(window.location.search).not.toContain('borough=');
    expect(window.location.search).not.toContain('type=');
    // The rail is gone, not empty: a filter control for a feature with no dimensions would
    // be a control that does nothing.
    expect(screen.queryByTestId('filter-rail')).not.toBeInTheDocument();

    await goTo(user, EAT_OPTION);

    // Eat Outside's own filters came back with it, from memory and without a request.
    expect(within(screen.getByTestId('filter-rail')).getByRole('radio', { name: /^Queens/ })).toBeChecked();
    expect(window.location.search).toContain('borough=Queens');
    // And it came back from MEMORY, not from the network: the module-level loader promise is
    // shared, so two switches away and back is still one request.
    expect(app.dataset.requests.filter((url) => url.includes('cafes.geojson'))).toHaveLength(1);
  });

  it('fetches the walk artifacts once, lazily, and never before it is selected', async () => {
    const user = userEvent.setup();
    const app = renderApp({ withMap: true });
    await waitForEatDrawn(app);

    const walkRequests = (artifact: string): number =>
      app.dataset.requests.filter((url) => url.includes(artifact)).length;
    // Nothing about the feature the visitor did not ask for.
    for (const artifact of WALK_ARTIFACTS) expect(walkRequests(artifact)).toBe(0);

    for (const name of [WALK_OPTION, EAT_OPTION, WALK_OPTION, EAT_OPTION]) {
      await goTo(user, name);
    }
    await goToWalk(user);

    // Four switches, one request per artifact. The feature object is cached for the life of
    // the app, and the promise behind it is memoised at module level exactly as
    // `loadLocationsOnce` is. The placeholder this test used to run against fetched ONE
    // manifest; the real feature needs four artifacts, and the property being asserted is
    // the same one at the correct granularity: no artifact is ever fetched twice.
    for (const artifact of WALK_ARTIFACTS) {
      expect(walkRequests(artifact), `${artifact} was fetched more than once`).toBe(1);
    }
  });

  it('opens a shared link straight into the feature it names', async () => {
    const app = renderApp({ search: '?mode=walk', withMap: true });
    // No switching at all: the walk artifacts are requested, because walk is what was asked
    // for, and the map ends up carrying this feature's layers rather than an empty one.
    await waitFor(() => {
      expect(app.dataset.requests.some((url) => url.includes('walk'))).toBe(true);
    });
    await screen.findByText(/shown only where NYC DOT measured it/i);
    expect(option(WALK_OPTION)).toHaveAttribute('aria-checked', 'true');
    expect(option(EAT_OPTION)).toHaveAttribute('aria-checked', 'false');
    expect(document.title).toContain('Where NYC Walks');
    expect(screen.getByTestId('map-canvas')).toHaveAccessibleName(/where nyc dot has counted pedestrians/i);
  });

  it('describes the map and the document in the feature\'s own words, and updates both', async () => {
    const user = userEvent.setup();
    const app = renderApp({ withMap: true });
    await waitForEatDrawn(app);

    expect(document.title).toBe('Eat Outside NYC');
    expect(screen.getByTestId('map-canvas')).toHaveAccessibleName(
      /participating outdoor dining places/i,
    );

    await goToWalk(user);

    expect(document.title).toBe('Where NYC Walks · Eat Outside NYC');
    expect(screen.getByTestId('map-canvas')).toHaveAccessibleName(
      /where nyc dot has counted pedestrians/i,
    );
  });

  it('is on screen in both views, because the header does not go away when the view does', async () => {
    const user = userEvent.setup();
    const app = renderApp({ withMap: true });
    await waitForEatDrawn(app);

    expect(option(WALK_OPTION)).toBeVisible();
    await user.click(screen.getByRole('radio', { name: /^List/ }));
    expect(screen.getByTestId('location-list')).toBeVisible();
    expect(option(WALK_OPTION)).toBeVisible();
  });

  it('is disabled while the selected feature has nothing to show', async () => {
    // A switch offered while there is no data would replace a working map with an empty one,
    // and the visitor would have no way back except the switcher they cannot use.
    renderApp({ dataset: { hang: true } });
    await screen.findByTestId('dataset-loading');

    for (const name of [EAT_OPTION, WALK_OPTION]) {
      expect(option(name)).toBeDisabled();
    }
    // Every other radio too, for the reason `app-data-states.test.tsx` already states: a
    // chip that cannot count must not offer itself.
    for (const radio of screen.getAllByRole('radio')) expect(radio).toBeDisabled();
  });

  it('is a real radiogroup: one tab stop, and the arrow keys move the selection', async () => {
    const user = userEvent.setup();
    const app = renderApp({ withMap: true });
    await waitForEatDrawn(app);

    const group = within(switcher()).getByRole('radio', { name: EAT_OPTION });
    expect(group).toHaveAttribute('tabindex', '0');
    expect(option(WALK_OPTION)).toHaveAttribute('tabindex', '-1');

    group.focus();
    await user.keyboard('{ArrowRight}');

    expect(option(WALK_OPTION)).toHaveAttribute('aria-checked', 'true');
    expect(option(WALK_OPTION)).toHaveFocus();
    expect(app.controller().getState().selectedId).toBeNull();

    // And they wrap, so a two-item group is not a dead end in either direction.
    await user.keyboard('{ArrowRight}');
    expect(option(EAT_OPTION)).toHaveAttribute('aria-checked', 'true');
  });
});

/**
 * THE REAL FEATURE, END TO END.
 *
 * Everything above is about the SWITCH: that it reuses one map, leaves one set of layers and
 * one set of listeners, and keeps each feature's own state. This block is about the other
 * half — that switching to Where NYC Walks actually puts that feature on screen, rather than
 * an empty map with a loadable name on it. A registry can be perfectly total and still wire
 * a placeholder to it, and the switch tests above would all pass.
 *
 * These render the app with an extent the walk fixtures are inside, because the default
 * `MIDTOWN_BOUNDS` contains three Eat Outside places and none of the walk ones, and an empty
 * list is this feature's honest answer at that camera.
 */
describe('where nyc walks is really on the map', () => {
  function walkApp() {
    return renderApp({ withMap: true, bounds: WALK_BOUNDS });
  }

  /** Eat Outside's list, once it has something in it. Its heading counts "places". */
  async function waitForEat(): Promise<void> {
    await screen.findByText(/\d+ places? in this area/i);
  }

  it('lists its own count sites, in its own words, under its own heading', async () => {
    const user = userEvent.setup();
    renderApp({ withMap: true, bounds: WALK_BOUNDS });
    await waitForEat();
    await goToWalk(user);

    // The heading is built from the FEATURE's noun. "places" here would mean the shell
    // picked the word, which is exactly what the registry's `nouns` member exists to stop.
    const heading = await screen.findByText(/count sites in this area/i);
    expect(heading.tagName).toBe('H2');
    // Nine fixtures, five historical sites and four counters.
    expect(heading.textContent).toBe('9 count sites in this area');
  });

  it('has a filter rail, a search box and a borough filter, none of which exist for walk', async () => {
    const user = userEvent.setup();
    renderApp({ withMap: true, bounds: WALK_BOUNDS });
    await waitForEat();
    await goToWalk(user);

    expect(screen.queryByTestId('filter-rail')).not.toBeInTheDocument();
    expect(screen.queryByRole('searchbox')).not.toBeInTheDocument();
    expect(window.location.search).not.toContain('borough=');
  });

  it('offers its own sort control, and the order it shows is the order the list is in', async () => {
    const user = userEvent.setup();
    renderApp({ withMap: true, bounds: WALK_BOUNDS });
    await waitForEat();
    await goToWalk(user);

    // The shell is showing the list view, so the rows are on screen and readable. They are
    // the alternative to the map, which is the whole reason `rows` is a registry member.
    await user.click(screen.getByRole('radio', { name: /^List/ }));

    const busiest = await screen.findByRole('radio', { name: /Busiest at the last survey/ });
    expect(busiest).toBeChecked();
    const first = firstRowName();
    expect(first).not.toBeNull();

    const biggestChange = screen.getByRole('radio', { name: /Changed the most/ });
    await user.click(biggestChange);
    expect(biggestChange).toBeChecked();
    // The control and the list cannot disagree: the row order moved, and the control is
    // claiming the order it moved to.
    expect(firstRowName()).not.toBe(first);
  });

  /** The first row's title, or null. Rows are `<button>`s inside the list's `<ul>`. */
  function firstRowName(): string | null {
    const list = screen.getByTestId('location-list');
    const first = list.querySelector('.eoy-row__name');
    return first === null ? null : first.textContent;
  }

  it('opens a sheet with the survey date and a DISCRETE bar per survey', async () => {
    const user = userEvent.setup();
    const app = walkApp();
    await waitForEat();
    await goToWalk(user);

    // Select from the map, the way a click on a dot does, rather than from the list: that is
    // the path that needs the registry's `setHandlers` channel and the walk click handler.
    const id = 'wsh-0000000000a1';
    act(() => {
      app.controller().selectFromMap(id);
    });

    const sheet = await screen.findByTestId('detail-sheet');
    expect(within(sheet).getByTestId('wnyc-detail-headline').textContent).toBe('Surveyed May 2026');
    // The chart, and it is bars — one `<rect>` per survey and no `<path>` anywhere, because
    // nothing was measured between two surveys.
    const chart = within(sheet).getByTestId('wnyc-chart-svg');
    expect(chart.getAttribute('role')).toBe('img');
    expect(chart.querySelectorAll('rect').length).toBeGreaterThan(1);
    expect(chart.querySelector('path')).toBeNull();
    // And the honesty sentence for this item, which walk always has and eat often has not.
    expect(within(sheet).getByTestId('wnyc-detail-caveat').textContent?.length).toBeGreaterThan(40);
    // The survey date appears ONCE. The shell's header and the feature's own body both had a
    // claim to it, and two identical sentences one line apart is a bug that only appears
    // once a feature brings its own body — so it is pinned here rather than left to be
    // noticed by eye.
    expect(screen.getAllByText('Surveyed May 2026')).toHaveLength(1);
    // And the chrome a dialog must have is still there: a role, a label, a close button.
    expect(sheet).toHaveAttribute('aria-modal', 'true');
    expect(sheet).toHaveAccessibleName(SURVEY_SITE);
    expect(
      within(sheet).getByRole('button', { name: /close details for/i }),
    ).toBeInTheDocument();
  });

  it('puts the walk legend, its swatches and its note on screen', async () => {
    const user = userEvent.setup();
    renderApp({ withMap: true, bounds: WALK_BOUNDS });
    await waitForEat();
    await goToWalk(user);

    // Walk's own legend renderer, not the shell's: its swatches are hollow rings and heavy
    // rims drawn from CSS custom properties, and the shell's three shape classes have no
    // entry for them.
    const swatches = [...document.querySelectorAll('.wnyc-legend__swatch')];
    expect(swatches).toHaveLength(9);
    expect(document.querySelector('.wnyc-legend__note')?.textContent).toContain(
      'shown only where NYC DOT measured it',
    );
    expect(screen.getByRole('link', { name: /How these counts are collected/i })).toBeInTheDocument();
  });
});

/**
 * The generic sheet is the path a feature takes when it does not bring its own, and it is
 * untested by everything above because Eat Outside brings its own and Where NYC Walks brings
 * its own body. It is walk's shape of detail, so it is covered here.
 */
describe('the generic detail sheet', () => {
  const DETAIL: FeatureDetail = {
    title: 'Broadway at W 231st St',
    headline: 'Surveyed May 2026',
    facts: [
      { label: 'Borough', value: 'Bronx' },
      { label: 'Survey period', value: 'Evening' },
    ],
    series: {
      title: 'Counts by survey',
      points: [
        { label: 'May 2007', value: 120 },
        { label: 'May 2026', value: 340 },
      ],
      // The whole reason the flag exists: two surveys are not a line.
      discrete: true,
      unit: 'people',
    },
    caveat: 'Last surveyed May 2026.',
  };

  it('is a labelled modal dialog that says what it is showing', () => {
    renderSheet(DETAIL);
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAccessibleName('Broadway at W 231st St');
    expect(dialog).toHaveTextContent('Surveyed May 2026');
    expect(within(dialog).getByText('Survey period')).toBeInTheDocument();
    // Discrete series: one bar per measurement, and the note says why there is no line.
    expect(dialog.querySelectorAll('.eoy-series__row')).toHaveLength(2);
    expect(dialog).toHaveTextContent(/nothing was measured between them/i);
    expect(screen.getByText('340 people')).toBeInTheDocument();
  });

  it('says "not surveyed" rather than drawing a zero for a missing measurement', () => {
    renderSheet({
      ...DETAIL,
      series: {
        title: 'Counts by survey',
        points: [
          { label: 'May 2007', value: null },
          { label: 'May 2026', value: 340 },
        ],
        discrete: true,
        unit: 'people',
      },
    });
    // A missing measurement is not a measurement of nothing — the same rule the walk
    // contract states for `activity: 'unavailable'`.
    expect(screen.getByText('not surveyed')).toBeInTheDocument();
  });

  it('traps focus and closes on Escape, and focus starts on the close button', async () => {
    const user = userEvent.setup();
    let closed = 0;
    renderSheet(DETAIL, () => {
      closed += 1;
    });

    const close = within(screen.getByRole('dialog')).getByRole('button', {
      name: /close details for/i,
    });
    await waitFor(() => {
      expect(close).toHaveFocus();
    });
    await user.keyboard('{Escape}');
    expect(closed).toBe(1);
  });
});

/** The sheet is a pure function of one `FeatureDetail`, so it needs no app around it. */
function renderSheet(detail: FeatureDetail, onClose: () => void = () => undefined): void {
  render(<ShellDetailSheet detail={detail} onClose={onClose} />);
}
