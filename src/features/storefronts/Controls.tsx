import type { JSX } from 'react';
import { useId, useRef, useState } from 'react';
import type { FeatureDetail, FilterSlotContext, SearchSlotContext, SheetSlotContext } from '../registry';
import type { Filters } from '../../lib/filters';
import { BOROUGHS } from '../../types/location';
import { geocodeSearch } from '../../lib/geocode';
import type { GeocodeResult } from '../../lib/geocode';
import type { StorefrontMetadata } from '../../types/storefronts';
import type { LoadedStorefronts } from './load';
import { normalizeStorefrontFilters } from './filters';
import type { ConstructionFilter, StatusFilter } from './filters';
import { ShellDetailSheet } from '../shell/ShellDetailSheet';
import { storefrontSourceAge } from './provenance';
import './storefronts.css';
export function StorefrontFiltersControl({ filters, onChange, disabled, loaded, metadata = loaded?.metadata ?? null }: FilterSlotContext<Filters> & { loaded: LoadedStorefronts | null; metadata?: StorefrontMetadata | null }): JSX.Element {
  const current = normalizeStorefrontFilters(filters);
  const supported = metadata?.coverage.find((c) => c.reportingYear === current.year)?.vacancyShareSupported;
  const older = loaded?.areas.areas.some((a) => a.reportingYear === current.year && a.ntaVintage === '2010');
  return <div className="sf-controls">
    <div className="sf-controls__fields">
      <label>Reporting period<select disabled={disabled && metadata === null} value={current.year} onChange={(e) => onChange({ ...current, year: e.target.value })}>
        {metadata !== null && !metadata.reportingYears.includes(current.year) ? <option value={current.year}>{current.year} (not published)</option> : null}
        {(metadata?.reportingYears ?? [current.year]).map((year) => <option key={year} value={year}>{year}</option>)}
      </select></label>
      <label>December status<select disabled={disabled && metadata === null} value={current.status} onChange={(e) => onChange({ ...current, status: e.target.value as StatusFilter })}>
        <option value="vacant">Reported vacant</option><option value="nonVacant">Reported non-vacant</option><option value="both">All reported records (including unknown)</option>
      </select></label>
      <label>Construction<select disabled={disabled && metadata === null} value={current.construction} onChange={(e) => onChange({ ...current, construction: e.target.value as ConstructionFilter })}>
        <option value="any">Any construction status</option><option value="reported">Reported</option><option value="notReported">Reported no</option><option value="unknown">Unknown / not reported</option>
      </select></label>
      <label>Borough<select disabled={disabled && metadata === null} value={current.borough} onChange={(e) => onChange({ ...current, borough: e.target.value as Filters['borough'] })}>
        <option value="all">All boroughs</option>{BOROUGHS.map((borough) => <option key={borough}>{borough}</option>)}
      </select></label>
    </div>
    <p className="sf-controls__note">{current.status === 'vacant' ? 'Neighborhood summaries at city scale; zoom in for reported-vacant records.' : 'Aggregate summaries in the map and list. Individual points are available in reported-vacant mode only; non-vacant reports are not published as points.'}</p>
    {metadata ? <p className="sf-controls__note">NYC Department of Finance · {storefrontSourceAge(metadata.source.updatedAt)} · <a href={methodologyHref()}>About the data</a></p> : null}
    {supported === false ? <p className="sf-controls__warning">{current.year}: no explicit non-vacant reporting population. Unknown December statuses remain included; vacancy share is unavailable.</p> : null}
    {older ? <p className="sf-controls__warning">Older source NTA geography: authoritative 2010 polygons are unavailable. Summaries remain in the list and reported-vacant points on the map; no current boundaries are substituted.</p> : null}
    {metadata !== null && !metadata.reportingYears.includes(current.year) ? <p className="sf-controls__warning">This reporting label is not in the published dataset. Choose a listed period.</p> : null}
  </div>;
}
export function StorefrontSearch({ onPickArea, geocode = geocodeSearch }: SearchSlotContext): JSX.Element {
  const id = useId();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<readonly GeocodeResult[]>([]);
  const [message, setMessage] = useState('');
  const request = useRef(0);
  return <div className="eoy-search sf-search"><form role="search" aria-label="Search NYC areas" onSubmit={(e) => {
    e.preventDefault(); const ticket = ++request.current; setResults([]); setMessage('Searching…');
    void geocode(query).then((outcome) => {
      if (ticket !== request.current) return;
      if (outcome.status === 'ok') { setResults(outcome.results); setMessage(`${outcome.results.length} areas found`); }
      else setMessage(outcome.status === 'empty' ? 'No matching NYC area found.' : 'Area search did not complete. Try again.');
    }).catch(() => { if (ticket === request.current) setMessage('Area search did not complete. Try again.'); });
  }}>
    <label className="eoy-visually-hidden" htmlFor={id}>Search for an NYC area, address or ZIP code</label>
    <div className="eoy-search__field"><input id={id} className="eoy-search__input" value={query} inputMode="search" placeholder="Search NYC area…" autoComplete="off" onChange={(e) => { request.current += 1; setQuery(e.target.value); setResults([]); setMessage(''); }} /><button type="submit" className="eoy-search__submit" aria-label="Search areas">↵</button></div>
    <span className="eoy-visually-hidden">Press Enter to search OpenStreetMap Nominatim. Nothing is requested while typing.</span>
  </form>
    {message ? <div className="eoy-search__panel"><p role="status">{message}</p>{results.map((result) => <button type="button" key={result.placeId} className="sf-search__result" onClick={() => { request.current += 1; setResults([]); setMessage(''); onPickArea(result); }}>{result.label}</button>)}</div> : null}
  </div>;
}
export function StorefrontSheet({ detail, loaded, ...context }: SheetSlotContext & { detail: FeatureDetail; loaded: LoadedStorefronts }): JSX.Element {
  return <ShellDetailSheet detail={detail} onClose={context.onClose} body={<>
    <p className="eoy-sheet__legal">{detail.headline}</p>
    <dl className="eoy-facts">{detail.facts.map((fact) => <div className="eoy-facts__row" key={fact.label}><dt className="eoy-facts__label">{fact.label}</dt><dd className="eoy-facts__value">{fact.value}</dd></div>)}</dl>
    <p className="eoy-sheet__note">{detail.caveat}</p>
    <p className="eoy-sheet__meta">NYC Department of Finance · {storefrontSourceAge(loaded.metadata.source.updatedAt)}</p>
    <div className="eoy-sheet__actions"><a href={loaded.metadata.source.url} target="_blank" rel="noreferrer">DOF source data</a><a href={methodologyHref()}>About the data and methodology</a>{context.onShowOnMap ? <button type="button" className="eoy-button" onClick={context.onShowOnMap}>Show on map</button> : null}</div>
  </>} />;
}
export function methodologyHref(): string { return 'https://github.com/qwertypants/hey-nyc/blob/main/docs/storefronts.md'; }
