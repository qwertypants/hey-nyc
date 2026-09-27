/**
 * ONE search box, TWO modes, and never a keystroke against a third party's server.
 *
 * The box is a combobox that answers two different questions, and it labels which one it
 * answered in every result:
 *
 *   Participating places  -> `searchLocations()` against the dataset already in memory.
 *                            No network at all, so no rate limit and no offline failure.
 *   Areas and places      -> Nominatim via `src/lib/geocode.ts`. The only outbound request
 *                            the app makes, and only on an explicit submit, because
 *                            Nominatim's usage policy forbids autocomplete on the public
 *                            instance. A request per keystroke against a free public
 *                            geocoder is the fastest way to get this app blocked.
 *
 * Both groups are produced by the SAME submit rather than by a mode switch or a heuristic.
 * A heuristic here is guesswork — "MADISON" is a street, a park and half a dozen restaurant
 * names — and a wrong guess sends someone walking to the wrong block. Two clearly labelled
 * groups cost one extra keystroke-free request and remove the guess entirely.
 *
 * The result list is a real ARIA combobox: `role="combobox"` on the input, `role="listbox"`
 * on the list, `role="group"` per mode, `role="option"` per hit, and `aria-activedescendant`
 * pointing at the highlighted one. That is what makes a highlighted result genuinely
 * `aria-selected`; a button per row would have had to fake it, and a faked `aria-selected` is
 * worse than none.
 *
 * Every geocoder outcome is a distinct sentence, because each needs a different action:
 *   rate-limited -> wait, then press Search again. We never auto-retry, on purpose.
 *   timeout     -> the network is slow, not wrong.
 *   offline     -> area search needs the network; the restaurant list still works.
 *   empty       -> the place is real, it just is not in New York.
 *   invalid     -> nothing was typed.
 * A failed area search is reported UNDER the area group, so good restaurant results above it
 * never look like the whole search failed.
 *
 * Public surface:
 *   type SearchHit, type SearchGroup
 *   SearchBox(props): JSX.Element
 */

import type { FocusEvent, FormEvent, JSX, KeyboardEvent } from 'react';
import { useEffect, useId, useRef, useState } from 'react';
import type { GeocodeOutcome, GeocodeResult } from '../lib/geocode';
import { geocodeSearch } from '../lib/geocode';
import type { LocationProperties } from '../types/location';
import { searchLocations } from '../lib/search';
import { formatAddress } from '../lib/format';
import { describeType } from '../map/style';
import { CloseIcon, SearchIcon } from './icons';

/** Nominal top matches. Enough to choose from, few enough to read on a phone. */
export const SEARCH_RESULT_LIMIT = 8;

export const AREA_GROUP_LABEL = 'Areas and places';
export const RESTAURANT_GROUP_LABEL = 'Participating places';

const AREA_GROUP_HINT = 'Matches from OpenStreetMap Nominatim';
const RESTAURANT_GROUP_HINT = 'Places with a Dining Out NYC licence';

export type SearchHit =
  | { readonly kind: 'restaurant'; readonly location: LocationProperties }
  | { readonly kind: 'area'; readonly result: GeocodeResult };

export interface SearchGroup {
  readonly label: string;
  readonly hint: string;
  readonly hits: readonly SearchHit[];
}

type Status = { readonly kind: 'idle' } | { readonly kind: 'busy' } | { readonly kind: 'message'; readonly text: string; readonly warn: boolean };

const IDLE: Status = { kind: 'idle' };

function areaStatusFor(outcome: GeocodeOutcome): Status {
  switch (outcome.status) {
    case 'ok':
      return IDLE;
    case 'empty':
      return { kind: 'message', text: `Nothing in New York matches “${outcome.query}”.`, warn: false };
    case 'invalid-query':
      return { kind: 'message', text: 'Type a place, an address or a ZIP code first.', warn: true };
    case 'rate-limited':
      return {
        kind: 'message',
        text: `The public place-search service is rate limiting us. Wait about ${Math.max(
          1,
          Math.round(outcome.retryAfterMs / 1000),
        )} seconds and press Search again.`,
        warn: true,
      };
    case 'timeout':
      return { kind: 'message', text: 'The place search timed out. Try again, or browse the list.', warn: true };
    case 'offline':
      return {
        kind: 'message',
        text: 'Place search needs a network connection. Restaurant-name search still works.',
        warn: true,
      };
    case 'error':
      return { kind: 'message', text: `Place search failed: ${outcome.message}`, warn: true };
  }
}

export interface SearchBoxProps {
  readonly locations: readonly LocationProperties[];
  /** Frames a geocoded place so the visitor sees the neighbourhood, not a lone dot. */
  readonly onPickArea: (result: GeocodeResult) => void;
  /** Selects and flies. The same call a list row makes. */
  readonly onPickRestaurant: (id: string) => void;
  /** Injected in tests so the geocoder never touches the network. */
  readonly geocode?: typeof geocodeSearch;
}

export function SearchBox({
  locations,
  onPickArea,
  onPickRestaurant,
  geocode = geocodeSearch,
}: SearchBoxProps): JSX.Element {
  const [query, setQuery] = useState('');
  /** Non-null once a submit has produced results; the panel is open exactly when it is set. */
  const [groups, setGroups] = useState<readonly SearchGroup[]>([]);
  const [panelOpen, setPanelOpen] = useState(false);
  const [areaStatus, setAreaStatus] = useState<Status>(IDLE);
  const [notice, setNotice] = useState<Status>(IDLE);
  const [active, setActive] = useState(-1);

  const inputId = useId();
  const listId = useId();
  const hintId = `${listId}-hint`;
  const inputRef = useRef<HTMLInputElement | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  // A request that lands after the visitor typed again, changed page or left is discarded.
  const requestRef = useRef(0);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const hits = groups.flatMap((group) => group.hits);

  function closePanel(): void {
    requestRef.current += 1;
    setPanelOpen(false);
    setGroups([]);
    setAreaStatus(IDLE);
    setNotice(IDLE);
    setActive(-1);
  }

  function pick(hit: SearchHit): void {
    closePanel();
    if (hit.kind === 'area') onPickArea(hit.result);
    else onPickRestaurant(hit.location.id);
  }

  function submit(event: FormEvent): void {
    event.preventDefault();

    const chosen = active >= 0 ? hits[active] : undefined;
    if (chosen !== undefined) {
      pick(chosen);
      return;
    }

    const trimmed = query.trim();
    setPanelOpen(true);
    setActive(-1);

    if (trimmed.length === 0) {
      setNotice({
        kind: 'message',
        text: 'Type a place, an address, a ZIP code or a name first.',
        warn: true,
      });
      return;
    }

    requestRef.current += 1;
    const ticket = requestRef.current;
    setNotice(IDLE);

    const local = searchLocations(locations, trimmed, { limit: SEARCH_RESULT_LIMIT });
    const localGroup: SearchGroup | null =
      local.length === 0
        ? null
        : {
            label: RESTAURANT_GROUP_LABEL,
            hint: RESTAURANT_GROUP_HINT,
            hits: local.map((location) => ({ kind: 'restaurant', location }) as SearchHit),
          };

    setGroups(localGroup === null ? [] : [localGroup]);
    setAreaStatus({ kind: 'busy' });

    void geocode(trimmed).then((outcome) => {
      if (!mountedRef.current || requestRef.current !== ticket) return;
      if (outcome.status === 'ok') {
        setAreaStatus(IDLE);
        setGroups((current) => {
          const areaGroup: SearchGroup = {
            label: AREA_GROUP_LABEL,
            hint: AREA_GROUP_HINT,
            hits: outcome.results.map((result) => ({ kind: 'area', result }) as SearchHit),
          };
          return current.length === 0 ? [areaGroup] : [...current, areaGroup];
        });
        return;
      }
      setAreaStatus(areaStatusFor(outcome));
    });
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    if (event.key === 'Escape') {
      if (panelOpen) {
        event.preventDefault();
        closePanel();
        return;
      }
      if (query.length > 0) {
        event.preventDefault();
        setQuery('');
        setNotice(IDLE);
      }
      return;
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    if (hits.length === 0) return;
    event.preventDefault();
    const delta = event.key === 'ArrowDown' ? 1 : -1;
    setActive((current) => {
      const next = current + delta;
      if (next < 0) return hits.length - 1;
      if (next >= hits.length) return 0;
      return next;
    });
  }

  function onRootBlur(event: FocusEvent<HTMLDivElement>): void {
    const next = event.relatedTarget;
    if (next !== null && event.currentTarget.contains(next as Node)) return;
    setActive(-1);
  }

  const showPanel =
    panelOpen && (hits.length > 0 || areaStatus.kind !== 'idle' || notice.kind !== 'idle');
  const busy = areaStatus.kind === 'busy';

  return (
    <div className="eoy-search" ref={rootRef} onBlur={onRootBlur}>
      <form
        className="eoy-search__form"
        role="search"
        aria-label="Search places and areas"
        onSubmit={submit}
      >
        <div className="eoy-search__field">
          <SearchIcon className="eoy-search__icon" />
          <label className="eoy-visually-hidden" htmlFor={inputId}>
            Search for an area, an address, a ZIP code or a participating restaurant
          </label>
          <input
            id={inputId}
            ref={inputRef}
            className="eoy-search__input"
            type="text"
            value={query}
            placeholder="Search area or place…"
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            role="combobox"
            aria-expanded={showPanel}
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={active >= 0 ? optionId(listId, active) : undefined}
            aria-describedby={hintId}
            onChange={(event) => {
              setQuery(event.target.value);
              // Results for the previous query are now misleading, so they go.
              closePanel();
            }}
            onKeyDown={onKeyDown}
          />
          {query.length > 0 ? (
            <button
              type="button"
              className="eoy-search__clear"
              onClick={() => {
                setQuery('');
                closePanel();
                inputRef.current?.focus();
              }}
            >
              <CloseIcon size={14} />
              <span className="eoy-visually-hidden">Clear search</span>
            </button>
          ) : null}
          <button type="submit" className="eoy-search__submit">
            <span className="eoy-visually-hidden">Search</span>
            <SearchIcon />
          </button>
        </div>
        <p className="eoy-visually-hidden" id={hintId}>
          Press Enter or Search to look this up. Matching place names come from the downloaded
          Dining Out NYC data; matching areas come from the public OpenStreetMap Nominatim
          service. Nothing is requested while you type.
        </p>
      </form>

      {/*
        The live region announces the RESULT COUNT only. Putting the failure sentence in here
        too would make a screen reader say everything twice — once from the polite region and
        once when the reader reaches the paragraph in the panel.
      */}
      <div className="eoy-visually-hidden" role="status" aria-live="polite">
        {busy ? 'Searching' : showPanel ? `${hits.length} results` : ''}
      </div>

      {/*
        The panel is always in the DOM and hidden when collapsed, so the input's
        `aria-controls` always resolves to a real element — the W3C combobox pattern needs the
        association to survive the popup closing. `role="listbox"` is applied only when there
        are options, because an empty visible listbox would be announced as a broken control.
      */}
      <div className="eoy-search__panel" id={listId} hidden={!showPanel}>
        {hits.length > 0 ? (
          <div className="eoy-search__results" role="listbox" aria-label="Search results">
            {groups.map((group) => (
              <div className="eoy-search__group" role="group" aria-label={group.label} key={group.label}>
                <p className="eoy-search__group-heading" aria-hidden="true">
                  <span className="eoy-search__group-name">{group.label}</span>
                  <span className="eoy-search__group-hint">{group.hint}</span>
                </p>
                {group.hits.map((hit) => {
                  const index = hits.indexOf(hit);
                  return (
                    <div
                      key={hit.kind === 'area' ? `area-${hit.result.placeId}` : hit.location.id}
                      id={optionId(listId, index)}
                      role="option"
                      aria-selected={index === active}
                      className="eoy-search__option"
                      onMouseEnter={() => setActive(index)}
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => pick(hit)}
                    >
                      <span className="eoy-search__option-name">
                        {hit.kind === 'area' ? hit.result.label : hit.location.name}
                      </span>
                      <span className="eoy-search__option-meta">
                        {hit.kind === 'area'
                          ? hit.result.kind
                          : `${formatAddress(hit.location)} · ${describeType(hit.location.type)}`}
                      </span>
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        ) : null}

        {busy ? (
          <p className="eoy-search__status" aria-hidden="true">
            Looking up areas…
          </p>
        ) : null}
        {areaStatus.kind === 'message' ? (
          <p className={`eoy-search__status${areaStatus.warn ? ' eoy-search__status--warn' : ''}`}>
            {AREA_GROUP_LABEL}: {areaStatus.text}
          </p>
        ) : null}
        {notice.kind === 'message' ? (
          <p className={`eoy-search__status${notice.warn ? ' eoy-search__status--warn' : ''}`}>
            {notice.text}
          </p>
        ) : null}
      </div>
    </div>
  );
}

function optionId(listId: string, index: number): string {
  return `${listId}-option-${index}`;
}
