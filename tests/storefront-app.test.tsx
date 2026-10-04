import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { App } from '../src/App';
import type { AppProps } from '../src/App';
import { createFakeController } from './helpers/fakeController';
import type { FakeController } from './helpers/fakeController';
import { installDatasetFetch } from './helpers/datasetFetch';
import { FIXTURES, METADATA_FIXTURE, makeCollection, MIDTOWN_BOUNDS } from './helpers/fixtures';
import { resetDatasetCache } from '../src/data/load';
import { resetWalkCache } from '../src/data/walk/load';
import { resetStorefrontCache } from '../src/features/storefronts/load';
import { AREA_ID, UNKNOWN_AREA_ID, REPORT_ID, sfPayload } from './storefront-fixtures';
beforeEach(() => { resetDatasetCache(); resetWalkCache(); resetStorefrontCache(); });
function mount(search = '', options: { holdYear?: string; failYear?: string } = {}) {
  window.history.replaceState(null, '', search || '/');
  const oldFetch = installDatasetFetch({ collection: makeCollection(FIXTURES), metadata: METADATA_FIXTURE });
  let released = false; let failed = options.failYear !== undefined;
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const requests: string[] = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
    const url = String(input); requests.push(url);
    if (!url.includes('data/storefronts/')) return oldFetch.fetchImpl(input);
    if (options.holdYear && url.includes(`/periods/${options.holdYear}/`) && !released) await gate;
    if (failed && url.includes(`/periods/${options.failYear}/`)) return { ok: false, status: 503 } as Response;
    return { ok: true, json: async () => sfPayload(url) } as Response;
  });
  vi.stubGlobal('fetch', fetchImpl);
  let controller: FakeController | null = null;
  const create = vi.fn((options: Parameters<NonNullable<AppProps['createController']>>[0]) => {
    controller = createFakeController(options, { autoReady: true, withMap: true, bounds: MIDTOWN_BOUNDS }); return controller;
  });
  const geocode = vi.fn(async () => ({ status: 'empty' as const, query: 'test' }));
  const result = render(<App createController={create} urlDelayMs={0} geocode={geocode} geolocation={null} />);
  return { ...result, requests, create, geocode, release: () => { released = true; release(); }, recover: () => { failed = false; }, controller: () => { if (!controller) throw new Error('no controller'); return controller; } };
}
function radio(name: RegExp) { return within(screen.getByTestId('feature-switcher')).getByRole('radio', { name }); }
async function ready() { await screen.findByText(/Areas show reported-record counts/); }
describe('Storefront Pulse in the shared app', () => {
  it('loads lazily and completes a three-mode sequence using one camera with no stale layers/listeners/selections', async () => {
    const app = mount(); const user = userEvent.setup();
    await waitFor(() => expect(radio(/Storefront Pulse/)).toBeEnabled());
    expect(app.requests.some((p) => p.includes('storefronts/'))).toBe(false);
    await user.click(radio(/Storefront Pulse/)); await ready();
    const map = app.controller().map(); if (!map) throw new Error('no map');
    await waitFor(() => expect(map.layerIds()).toContain('sf-points'));
    const sfListeners = map.listenerCount(); const view = app.controller().getState().view;
    act(() => app.controller().setSelectedId(REPORT_ID)); await screen.findByRole('dialog');
    await user.keyboard('{Escape}');
    await user.click(radio(/Where NYC Walks/)); await screen.findByText(/shown only where NYC DOT measured it/i);
    expect(map.layerIds().some((id) => id.startsWith('sf-'))).toBe(false);
    await user.click(radio(/Eat Outside NYC/)); await waitFor(() => expect(radio(/Eat Outside NYC/)).toHaveAttribute('aria-checked', 'true'));
    await user.click(radio(/Storefront Pulse/)); await ready();
    expect(map.listenerCount()).toBe(sfListeners); expect(app.create).toHaveBeenCalledOnce();
    expect(app.controller().getState().view).toEqual(view); expect(app.controller().getState().selectedId).toBeNull();
    expect(app.requests.filter((p) => p.includes('data/storefronts/'))).toHaveLength(4);
  });
  it('opens a literal reporting-period URL directly and restores an area selection', async () => {
    const app = mount(`?mode=storefronts&year=2025&status=both&construction=unknown&sel=area-${'e'.repeat(24)}`);
    await ready(); await screen.findByRole('dialog');
    expect(app.controller().initial.initialFilters).toMatchObject({ year: '2025', status: 'both', construction: 'unknown' });
    expect(app.requests.some((p) => /storefronts\/areas.json$/.test(p))).toBe(false);
    expect(screen.getByRole('dialog')).toHaveTextContent('Unavailable: cohort does not support a denominator');
    expect(window.location.search).toContain('year=2025');
  });
  it('restores a shared reported-record sheet and refuses unknown as false or activity as business history', async () => {
    mount(`?mode=storefronts&sel=${REPORT_ID}`); await ready();
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('Raw reported business activity'); expect(dialog).toHaveTextContent('OTHER');
    expect(dialog).toHaveTextContent('Not reported'); expect(dialog).toHaveTextContent('not a verified previous business');
    expect(within(dialog).getByRole('link', { name: 'DOF source data' })).toHaveAttribute('href', expect.stringContaining('92iy-9c3n'));
  });
  it('shows cohort loading with no stale rows and recovers from period failure by retry', async () => {
    const user = userEvent.setup(); const app = mount('?mode=storefronts', { holdYear: '2025', failYear: '2025' }); await ready();
    await user.click(screen.getByRole('radio', { name: /^List/ }));
    expect(screen.getByText('Midtown Test', { selector: '.eoy-row__name' })).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText('Reporting period'), '2025');
    expect(screen.getByText('Loading storefront reports')).toBeInTheDocument();
    expect(screen.queryByText('Midtown Test', { selector: '.eoy-row__name' })).toBeNull();
    app.release(); await screen.findByText('Storefront reports did not load');
    expect(screen.getByLabelText('Reporting period')).toBeEnabled(); expect(window.location.search).toContain('year=2025');
    app.recover(); await user.click(screen.getByRole('button', { name: /Try again/ }));
    await waitFor(() => expect(screen.queryByText('Storefront reports did not load')).toBeNull());
    await screen.findByText(/2025: no explicit non-vacant reporting population/);
  });
  it('offers explicit recovery for a requested label absent from the manifest, without showing the default cohort', async () => {
    const user = userEvent.setup(); const app = mount('?mode=storefronts&year=2026');
    await screen.findByText('Storefront reports did not load');
    expect(screen.getByText(/2026 is not published/)).toBeInTheDocument(); expect(window.location.search).toContain('year=2026');
    expect(app.requests.some((p) => /storefronts\/areas.json$/.test(p))).toBe(false);
    await user.selectOptions(screen.getByLabelText('Reporting period'), '2024'); await ready();
    expect(screen.getByLabelText('Reporting period')).toHaveValue('2024'); expect(window.location.search).not.toContain('year=2026');
  });
  it('keeps aggregate-only status choices in the street-level list and clears a newly filtered selection', async () => {
    const user = userEvent.setup(); const app = mount('?mode=storefronts&z=15'); await ready();
    await user.click(screen.getByRole('radio', { name: /^List/ }));
    expect(screen.getByText('12 TEST STREET')).toBeInTheDocument();
    act(() => app.controller().setSelectedId(REPORT_ID)); await screen.findByRole('dialog'); await user.keyboard('{Escape}');
    await user.selectOptions(screen.getByLabelText('December status'), 'nonVacant');
    expect(screen.queryByText('12 TEST STREET')).toBeNull(); expect(screen.getByText(/Aggregate summaries in the map and list/)).toBeInTheDocument();
    expect(screen.getByText('Midtown Test', { selector: '.eoy-row__name' })).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText('December status'), 'vacant');
    act(() => app.controller().setSelectedId(REPORT_ID)); await screen.findByRole('dialog'); await user.keyboard('{Escape}');
    act(() => app.controller().setSelectedId(REPORT_ID));
    act(() => app.controller().setFilters({ type: 'all', borough: 'Queens' }));
    await waitFor(() => expect(app.controller().getState().selectedId).toBeNull());
  });
  it('opens an unmapped summary from the list without flying to invented coordinates', async () => {
    const user = userEvent.setup(); const app = mount('?mode=storefronts'); await ready();
    await user.click(screen.getByRole('radio', { name: /^List/ })); await user.click(screen.getByText('Unknown geography'));
    await screen.findByRole('dialog'); expect(app.controller().getState().selectedId).toBe(UNKNOWN_AREA_ID);
    expect(app.controller().calls.flyTo).not.toHaveBeenCalled();
  });
  it('refreshes the list when camera scale changes and clears cross-mode URL state', async () => {
    const user = userEvent.setup(); const app = mount(`?mode=storefronts&sel=${AREA_ID}`); await ready(); await screen.findByRole('dialog'); await user.keyboard('{Escape}');
    await user.click(screen.getByRole('radio', { name: /^List/ })); expect(screen.queryByText('12 TEST STREET')).toBeNull();
    act(() => app.controller().setBounds(MIDTOWN_BOUNDS, { zoom: 15 })); expect(screen.getByText('12 TEST STREET')).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText('Construction'), 'unknown');
    await waitFor(() => expect(window.location.search).toContain('construction=unknown'));
    await user.click(radio(/Eat Outside NYC/)); await waitFor(() => expect(window.location.search).not.toContain('construction'));
  });
  it('applies a period choice made before the first controller exists', async () => {
    const user = userEvent.setup(); const app = mount('?mode=storefronts&year=2025', { holdYear: '2025' });
    await waitFor(() => expect(screen.getByLabelText('Reporting period')).toBeEnabled());
    await user.selectOptions(screen.getByLabelText('Reporting period'), '2024'); await ready();
    expect(app.controller().getState().filters.year).toBe('2024');
    expect(screen.getByLabelText('Reporting period')).toHaveValue('2024');
    app.release();
    await waitFor(() => expect(screen.queryByText('Loading storefront reports')).toBeNull());
    expect(app.controller().getState().filters.year).toBe('2024');
  });
  it('passes accessibility checks for controls, summary dialog and error recovery', async () => {
    const app = mount('?mode=storefronts'); await ready();
    const audit = async () => {
      const result = await axe.run(document.body, { rules: { 'color-contrast': { enabled: false } } });
      expect(result.violations.map((v) => ({ id: v.id, nodes: v.nodes.map((n) => n.target) }))).toEqual([]);
    };
    await audit();
    act(() => app.controller().setSelectedId(AREA_ID)); await screen.findByRole('dialog'); await audit();
  });
  it('uses geographic search only on Enter and retains source attribution', async () => {
    const user = userEvent.setup(); const app = mount('?mode=storefronts'); await ready();
    const input = screen.getByLabelText('Search for an NYC area, address or ZIP code'); await user.type(input, 'test'); expect(app.geocode).not.toHaveBeenCalled();
    await user.keyboard('{Enter}'); expect(app.geocode).toHaveBeenCalledOnce();
    expect(screen.getByText(/NYC Department of Finance/)).toBeInTheDocument();
    expect(screen.queryByLabelText(/activity/i)).toBeNull();
  });
});
