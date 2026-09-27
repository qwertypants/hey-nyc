/**
 * Dataset lifecycle: loading, ready, failure, retry.
 *
 * These drive the real `useDataset` -> `load.ts` -> `dataset.ts` chain with only `fetch`
 * replaced, so the states under test are the ones that ship.
 */

import { describe, expect, it } from 'vitest';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderApp } from './helpers/render';
import { makeCollection, FIXTURES, MIDTOWN_BOUNDS } from './helpers/fixtures';

describe('dataset states', () => {
  it('shows a loading state and only then the map, so the wrong thing never flashes', async () => {
    const app = renderApp({ dataset: { hang: true } });

    const loading = await screen.findByTestId('dataset-loading');
    expect(within(loading).getByRole('status')).toHaveTextContent(/loading places/i);
    // Nothing that needs data is reachable yet.
    expect(screen.getByRole('button', { name: /near me/i })).toBeDisabled();
    // The filter rail is the primary control, so it is inert until there is a dataset to
    // count — a chip showing "0" while the file is still downloading would be a lie.
    for (const chip of screen.getAllByRole('radio')) expect(chip).toBeDisabled();
    // The map container is in the DOM from the first frame, so the layout does not jump and
    // the loading card covers a real surface instead of appearing after a reflow.
    expect(screen.getByTestId('map-canvas')).toBeInTheDocument();
    // The list must not claim "0 places in this area" before there is any data: an empty
    // dataset and an unloaded one look identical on screen and mean opposite things.
    expect(screen.queryByText(/in this area/i)).not.toBeInTheDocument();

    app.dataset.release();

    await waitFor(() => {
      expect(screen.queryByTestId('dataset-loading')).not.toBeInTheDocument();
      // The controller is created in an effect once there is data to draw, so the controls
      // that need a map become live one render after the loading card goes away.
      expect(screen.getByRole('button', { name: /near me/i })).toBeEnabled();
    });
    for (const chip of screen.getAllByRole('radio')) expect(chip).toBeEnabled();
    // MIDTOWN_BOUNDS contains exactly three fixture places.
    expect(screen.getAllByText(/3 places in this area/i).length).toBeGreaterThan(0);
    expect(app.controller().getState().bounds).toEqual(MIDTOWN_BOUNDS);
  });

  it('reports a network failure, and a retry then succeeds', async () => {
    const user = userEvent.setup();
    const app = renderApp({
      dataset: { fail: new Error('Request for /data/cafes.geojson failed with status 503') },
    });

    const alert = await screen.findByTestId('dataset-error');
    expect(within(alert).getByRole('alert')).toHaveTextContent(/place list did not load/i);
    expect(alert).toHaveTextContent(/503/);
    // Critically: it must not read as "there are no places here".
    expect(screen.queryByText(/0 places in this area/i)).not.toBeInTheDocument();
    expect(screen.queryByTestId('location-list')).not.toBeInTheDocument();

    app.dataset.setFailure(null);
    await user.click(screen.getByRole('button', { name: /try again/i }));

    await waitFor(() => {
      expect(screen.queryByTestId('dataset-error')).not.toBeInTheDocument();
      expect(screen.getAllByText(/3 places in this area/i).length).toBeGreaterThan(0);
    });
    // The controller is created in an effect, so wait for the map to exist before poking it.
    await waitFor(() => {
      expect(app.controller().getState().status).toBe('ready');
    });
  });

  it('rejects a payload that fails contract validation, and recovers on retry', async () => {
    const user = userEvent.setup();
    // An empty FeatureCollection is refused by `validateCollection` rather than rendered as
    // a blank map, which would be indistinguishable from "no outdoor dining here".
    const app = renderApp({
      dataset: { collection: { type: 'FeatureCollection', features: [] } },
    });

    const alert = await screen.findByTestId('dataset-error');
    expect(alert).toHaveTextContent(/features is empty/i);

    app.dataset.setCollection(makeCollection(FIXTURES));
    await user.click(screen.getByRole('button', { name: /try again/i }));

    await waitFor(() => {
      expect(screen.queryByTestId('dataset-error')).not.toBeInTheDocument();
    });
    // The controller is created in an effect, one render after the data lands, so wait for
    // the map to exist rather than reading it the instant the error card goes.
    await waitFor(() => {
      expect(app.controller().getState().status).toBe('ready');
    });
  });

  it('shows a basemap-loading chip that is visibly not the dataset-loading card', async () => {
    const app = renderApp({ mapPending: true });

    // The data is ready, so the full-screen dataset skeleton must NOT be showing.
    await waitFor(() => {
      expect(screen.queryByTestId('dataset-loading')).not.toBeInTheDocument();
    });
    const chip = await screen.findByTestId('map-loading');
    expect(chip).toHaveAttribute('role', 'status');
    expect(chip).toHaveTextContent(/loading the basemap/i);
    expect(app.controller().getState().status).toBe('loading');

    act(() => {
      app.controller().ready();
    });
    await waitFor(() => {
      expect(screen.queryByTestId('map-loading')).not.toBeInTheDocument();
    });
  });

  it('surfaces a basemap failure without hiding the data', async () => {
    const app = renderApp({});

    await waitFor(() => {
      expect(app.controller().getState().status).toBe('ready');
    });

    act(() => {
      app.controller().fail(new Error('Failed to fetch style.json'));
    });

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/basemap could not be loaded/i);
    expect(alert).toHaveTextContent(/the list still has every place/i);
    expect(alert).toHaveTextContent(/style\.json/);
    // The data is still loaded, still counted, and still reachable.
    expect(screen.getAllByText(/3 places in this area/i).length).toBeGreaterThan(0);
    expect(screen.getByTestId('location-list')).toBeInTheDocument();
  });
});
