/**
 * Every non-content state the app can be in, and the chrome for each.
 *
 * These are deliberately not spinners. A spinner tells the user nothing about whether the
 * network is slow, the server is down, or the filter combination has no matches — and
 * getting those three confused is how a map app ends up showing "no places here" when the
 * truth is "the data failed to load". Each state says what happened, what it means, and
 * what to do next, in that order.
 *
 * THE COPY IS THE FEATURE'S. The card, the role, the retry button and the shimmer are the
 * shell's; the two sentences are not, and pretending otherwise is how "The place list did
 * not load" ends up on a page about pedestrian counts. The feature supplies them through
 * `MapFeature.copy.data`, which is why `src/features/registry.ts` has a `copy` member at
 * all rather than leaving these two sentences hard-coded here.
 *
 * The empty state is the same story with more sentences, so it takes the feature's NOUNS and
 * its own name for the dimensions being filtered. "No place in the dataset matches this
 * combination of dining type and borough" is a true sentence here and a false one anywhere
 * else.
 *
 * Public surface:
 *   DataLoadingState, DataErrorState, MapLoadingState, MapErrorState, ListEmptyState
 */

import type { JSX } from 'react';
import { formatPluralizedCount } from '../lib/format';
import type { Nouns, StateCopy } from '../features/registry';

export function DataLoadingState({ copy }: { readonly copy: StateCopy }): JSX.Element {
  return (
    <div className="eoy-overlay" data-testid="dataset-loading">
      <div className="eoy-card" role="status" aria-live="polite">
        <h2 className="eoy-card__title">{copy.title}</h2>
        <p className="eoy-card__body">{copy.body}</p>
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

export interface DataErrorStateProps {
  readonly copy: StateCopy;
  readonly error: Error | null;
  readonly onRetry: () => void;
}

export function DataErrorState({ copy, error, onRetry }: DataErrorStateProps): JSX.Element {
  return (
    <div className="eoy-overlay" data-testid="dataset-error">
      <div className="eoy-card eoy-card--error" role="alert">
        <h2 className="eoy-card__title">{copy.title}</h2>
        <p className="eoy-card__body">{copy.body}</p>
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
 * The basemap is a SEPARATE network request from the data, and it can fail on its own.
 * This is a chip rather than a full-screen card on purpose: the data is already here, and
 * covering the list with an error page would throw away every reachable item because a
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
  readonly nouns: Nouns;
  /** The feature's own name for what is being filtered, and what to try next. */
  readonly filtering: { readonly dimensions: string; readonly retryHint: string };
  readonly onZoomToAll: () => void;
  readonly onClearFilters: () => void;
}

export function ListEmptyState({
  inViewCount,
  datasetCount,
  filtered,
  nouns,
  filtering,
  onZoomToAll,
  onClearFilters,
}: ListEmptyStateProps): JSX.Element {
  // Three genuinely different situations, and the wording keeps them apart. "Nothing here"
  // and "nothing like that anywhere" send the visitor to opposite next steps — one to pan,
  // one to change the filter — so a single generic "no results" would be actively unhelpful.
  const noFilters = inViewCount === 0 && !filtered;
  const emptyDataset = filtered && datasetCount === 0;

  const title = noFilters
    ? `No ${nouns.many} in this area`
    : emptyDataset
      ? `No ${nouns.many} match these filters`
      : `No matching ${nouns.many} in this area`;

  const body = noFilters
    ? `The list follows whatever the map is showing, and there is nothing in it here. Pan or zoom out, or zoom to every ${nouns.one} in the city.`
    : emptyDataset
      ? `No ${nouns.one} in the dataset matches this combination of ${filtering.dimensions}. ${filtering.retryHint}`
      : `Places do match these filters, they are just not in the part of the map you are looking at.`;

  return (
    <div className="eoy-card eoy-card--inset">
      <h3 className="eoy-card__title eoy-card__title--small">{title}</h3>
      <p className="eoy-card__body">{body}</p>
      <div className="eoy-card__actions">
        {datasetCount > 0 ? (
          <button type="button" className="eoy-button eoy-button--primary" onClick={onZoomToAll}>
            Zoom to all {formatPluralizedCount(datasetCount, nouns.one, nouns.many)}
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
