/**
 * Every non-content state the app can be in, and the copy for each.
 *
 * These are deliberately not spinners. A spinner tells the user nothing about whether the
 * network is slow, the server is down, or the filter combination has no matches — and
 * getting those three confused is how a map app ends up showing "no places here" when the
 * truth is "the data failed to load". Each state says what happened, what it means, and
 * what to do next, in that order.
 *
 * Public surface:
 *   DatasetLoadingState, DatasetErrorState, ListEmptyState
 */

import type { JSX } from 'react';
import { formatBoroughCount } from '../lib/format';
import { DATA_ATTRIBUTION_TEXT } from '../lib/attribution';

export function DatasetLoadingState(): JSX.Element {
  return (
    <div className="eoy-overlay" data-testid="dataset-loading">
      <div className="eoy-card" role="status" aria-live="polite">
        <h2 className="eoy-card__title">Loading places</h2>
        <p className="eoy-card__body">
          Fetching the Dining Out NYC locations published by the city. This runs once and is
          then cached by the browser.
        </p>
        {/* Shimmer bars are aria-hidden decoration; the text above is the message. */}
        <div aria-hidden="true">
          <div className="eoy-skeleton eoy-skeleton--wide" />
          <div className="eoy-skeleton" />
          <div className="eoy-skeleton eoy-skeleton--narrow" />
        </div>
      </div>
    </div>
  );
}

export interface DatasetErrorStateProps {
  readonly error: Error | null;
  readonly onRetry: () => void;
}

export function DatasetErrorState({ error, onRetry }: DatasetErrorStateProps): JSX.Element {
  return (
    <div className="eoy-overlay" data-testid="dataset-error">
      <div className="eoy-card eoy-card--error" role="alert">
        <h2 className="eoy-card__title">The place list did not load</h2>
        <p className="eoy-card__body">
          Nothing is shown because an empty map would look like "there are no outdoor dining
          places here", which is not something this app knows. {DATA_ATTRIBUTION_TEXT}
        </p>
        {error === null ? null : (
          <p className="eoy-card__detail">{error.message}</p>
        )}
        <button type="button" className="eoy-button eoy-button--primary" onClick={onRetry}>
          Try again
        </button>
      </div>
    </div>
  );
}

/**
 * The basemap is a SEPARATE network request from the dataset, and it can fail on its own.
 * This is a chip rather than a full-screen card on purpose: the data is already here, and
 * covering the list with an error page would throw away 2 000 reachable places because a
 * tile server is unhappy. Deliberately not a skeleton either — "loading" and "failed" are
 * different facts and must not look alike.
 */
export function MapLoadingState(): JSX.Element {
  return (
    <p className="eoy-map-chip" role="status" data-testid="map-loading">
      Loading the basemap…
    </p>
  );
}

export function MapErrorState({ error }: { readonly error: Error | null }): JSX.Element {
  return (
    <div className="eoy-notice" role="alert">
      <p className="eoy-notice__text">
        The basemap could not be loaded, so the pins are not drawn. The list still has every
        place, and search still works.
        {error === null ? null : ` ${error.message}`}
      </p>
    </div>
  );
}

export interface ListEmptyStateProps {
  /** Nothing in view at all. */
  readonly inViewCount: number;
  /** Nothing in the whole dataset under the active filters. */
  readonly datasetCount: number;
  readonly filtered: boolean;
  readonly onZoomToAll: () => void;
  readonly onClearFilters: () => void;
}

export function ListEmptyState({
  inViewCount,
  datasetCount,
  filtered,
  onZoomToAll,
  onClearFilters,
}: ListEmptyStateProps): JSX.Element {
  // Three genuinely different situations, and the wording keeps them apart. "Nothing here"
  // and "nothing like that anywhere" send the visitor to opposite next steps — one to pan,
  // one to change the filter — so a single generic "no results" would be actively unhelpful.
  const noFilters = inViewCount === 0 && !filtered;
  const emptyDataset = filtered && datasetCount === 0;

  const title = noFilters
    ? 'No places in this area'
    : emptyDataset
      ? 'No places match these filters'
      : 'No matching places in this area';

  const body = noFilters
    ? 'The list follows whatever the map is showing, and there is nothing in it here. Pan or zoom out, or zoom to every place in the city.'
    : emptyDataset
      ? 'No place in the dataset matches this combination of dining type and borough. Try a different dining type, or a different borough.'
      : 'Places do match these filters, they are just not in the part of the map you are looking at.';

  return (
    <div className="eoy-card eoy-card--inset">
      <h3 className="eoy-card__title eoy-card__title--small">{title}</h3>
      <p className="eoy-card__body">{body}</p>
      <div className="eoy-card__actions">
        {datasetCount > 0 ? (
          <button type="button" className="eoy-button eoy-button--primary" onClick={onZoomToAll}>
            Zoom to all {formatBoroughCount(datasetCount)}
          </button>
        ) : null}
        {filtered ? (
          <button type="button" className="eoy-button" onClick={onClearFilters}>
            Clear filters
          </button>
        ) : null}
      </div>
    </div>
  );
}
