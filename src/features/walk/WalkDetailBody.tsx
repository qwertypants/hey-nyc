/**
 * INTEGRATION NOTES (src/features/walk/WalkDetailBody.tsx)
 *
 * The BODY of the detail sheet for a walk selection, rendered from the registry's
 * `FeatureDetail`. The shell keeps the sheet chrome — the dialog, the focus trap, the close
 * button, the title element — and drops this in, so the two features' sheets behave
 * identically for free and this feature only owns its words.
 *
 *   <WalkDetailBody detail={feature.detail(selectedId)} />
 *
 * WHY THE FACTS ARE A `<dl>` AND NOT A TABLE. A two-column table of label/value pairs
 * invites a header row nobody has, and a `<dl>` is the element whose whole purpose is
 * "this term means that value". The terms are what a screen reader reads out, so they are
 * written as questions' answers rather than as field names: "Survey date", not `latestSurvey`.
 *
 * THE HEADLINE IS ITS OWN ELEMENT, AND IT IS THE MOST IMPORTANT STRING IN THE FEATURE. For a
 * survey site it is the date; for a counter it is the freshness. It is a `<p>` above the
 * facts rather than a fact row, because a fact row reads as one item among many and this is
 * the one that changes what every other number means.
 *
 * THE CAVEAT IS `<p role="note">`… which is not a thing. It is a plain `<p>` with its own
 * class and, for a sensor, a `data-testid` so a test can assert on the honesty sentence
 * specifically rather than on the whole sheet's text. It is never omitted: `caveat` is
 * nullable in the registry because the eat feature has nothing to say for some of its
 * locations, and walk always has something to say.
 *
 * Public surface:
 *   WalkDetailBody, WalkDetailBodyProps
 */

import type { JSX } from 'react';
import type { FeatureDetail } from '../registry';
import { WalkSeriesChart } from './WalkSeriesChart';

export interface WalkDetailBodyProps {
  readonly detail: FeatureDetail;
}

export function WalkDetailBody({ detail }: WalkDetailBodyProps): JSX.Element {
  const { headline, facts, series, caveat } = detail;

  return (
    <div className="wnyc-detail" data-testid="wnyc-detail">
      <p className="wnyc-detail__headline" data-testid="wnyc-detail-headline">
        {headline}
      </p>

      <dl className="wnyc-detail__facts">
        {facts.map((fact) => (
          <div className="wnyc-detail__fact" key={`${fact.label}:${fact.value}`}>
            <dt className="wnyc-detail__label">{fact.label}</dt>
            <dd className="wnyc-detail__value">{fact.value}</dd>
          </div>
        ))}
      </dl>

      {series === undefined ? null : <WalkSeriesChart series={series} />}

      {caveat === null ? null : (
        <p className="wnyc-detail__caveat" data-testid="wnyc-detail-caveat">
          {caveat}
        </p>
      )}
    </div>
  );
}
