/**
 * THE GENERIC DETAIL SHEET.
 *
 * The chrome — `role="dialog"`, `aria-modal`, the focus trap, Escape, the close button, the
 * grabbable grip and the scrim — belongs to the shell, because it is the same for every
 * feature and because `aria-modal` is only honest if the rest of the app is really `inert`,
 * which is the shell's business. The WORDS belong to the feature, and they arrive as
 * `FeatureDetail`: already-formatted strings, formatted in exactly one place.
 *
 * A feature whose detail really is a title, a headline, some facts and a caveat renders
 * here. A feature whose detail is richer — Eat Outside's is a licence type list, an address
 * block, a seasonal note and a directions link — brings its own sheet through
 * `MapFeature.controls.sheet` and this is not used. Both paths exist because the second is
 * not a downgrade from the first; it is a different shape of data.
 *
 * A THIRD path, and it is the one Where NYC Walks takes: reuse this chrome and replace only
 * the body, via the `body` prop. The dialog semantics, the focus trap and the close button
 * are not a feature's to reimplement.
 *
 * `series.discrete` is load-bearing. DOT's manual counts are SEPARATE SURVEYS, and drawing a
 * continuous line between two of them draws a claim about the months in between that nobody
 * measured. The flag is required, so a feature that forgets it fails to compile rather than
 * quietly interpolating.
 *
 * Public surface:
 *   ShellDetailSheetProps, ShellDetailSheet(props): JSX.Element
 */

import type { JSX, ReactNode } from 'react';
import { useId, useRef } from 'react';
import type { FeatureDetail } from '../registry';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import { CloseIcon, MapIcon } from '../../components/icons';

export interface ShellDetailSheetProps {
  readonly detail: FeatureDetail;
  readonly onClose: () => void;
  /** Rendered as a secondary action only when the list is covering the map. */
  readonly onShowOnMap?: () => void;
  /**
   * The feature's own body, rendered instead of the generic facts/chart/caveat below.
   *
   * This is how a feature reuses the sheet CHROME — the `role="dialog"`, `aria-modal`, the
   * focus trap, Escape, the grip, the title element and the close button — without
   * re-implementing any of it. Those are not the feature's to get right: `aria-modal` is
   * only honest while the rest of the app is really `inert`, and a focus trap is a thing
   * that is either correct or a keyboard trap. So a feature that wants a richer sheet
   * supplies a body and gets all of it for free, and one that brings its OWN chrome (Eat
   * Outside's licence sheet, whose header is the legal name rather than `detail.headline`)
   * uses `MapFeature.controls.sheet` instead.
   *
   * `detail` is still required and still supplies the title and the close button's accessible
   * name, so a custom body can never produce an unlabelled dialog. It does NOT supply the
   * header's second line when a custom body is present — see the render.
   */
  readonly body?: ReactNode;
}

export function ShellDetailSheet({
  detail,
  onClose,
  onShowOnMap,
  body,
}: ShellDetailSheetProps): JSX.Element {
  const sheetRef = useRef<HTMLDivElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const titleId = useId();

  useFocusTrap(sheetRef, { active: true, onEscape: onClose, initialFocus: closeRef });

  return (
    <div
      className="eoy-sheet"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      ref={sheetRef}
      data-testid="detail-sheet"
    >
      <div className="eoy-sheet__grip" aria-hidden="true" />

      <div className="eoy-sheet__head">
        <div>
          <h2 className="eoy-sheet__title" id={titleId}>
            {detail.title}
          </h2>
          {/*
            The shell's own emphasis line, and ONLY when the shell is drawing the body.

            A custom `body` is by definition the feature's own interior, and the feature
            decides what its most important sentence is and where it goes — Where NYC Walks
            prints the survey date as its own element above the facts, which is right, and
            printing the same string again here put two identical sentences one line apart.
            So a custom body suppresses this: what a dialog must have is a role, a label, an
            escape and a close button, and the words inside it belong to the feature.
          */}
          {body === undefined ? <p className="eoy-sheet__legal">{detail.headline}</p> : null}
        </div>
        <button type="button" className="eoy-sheet__close" ref={closeRef} onClick={onClose}>
          <CloseIcon />
          <span className="eoy-visually-hidden">Close details for {detail.title}</span>
        </button>
      </div>

      <div className="eoy-sheet__body">
        {body ?? (
          <FeatureDetailBody
            detail={detail}
            {...(onShowOnMap === undefined ? {} : { onShowOnMap })}
          />
        )}
      </div>
    </div>
  );
}

/** The generic body: the facts, the series and the caveat, in that order. */
function FeatureDetailBody({
  detail,
  onShowOnMap,
}: {
  readonly detail: FeatureDetail;
  readonly onShowOnMap?: () => void;
}): JSX.Element {
  return (
    <>
      {detail.facts.length === 0 ? null : (
        <dl className="eoy-facts">
          {detail.facts.map((fact) => (
            <div className="eoy-facts__row" key={fact.label}>
              <dt className="eoy-facts__label">{fact.label}</dt>
              <dd className="eoy-facts__value">{fact.value}</dd>
            </div>
          ))}
        </dl>
      )}

      {detail.series === undefined ? null : (
        <FeatureSeriesChart series={detail.series} />
      )}

      {detail.caveat === null ? null : <p className="eoy-sheet__note">{detail.caveat}</p>}

      <div className="eoy-sheet__actions">
        {onShowOnMap === undefined ? null : (
          <button type="button" className="eoy-button" onClick={onShowOnMap}>
            <MapIcon />
            Show on map
          </button>
        )}
      </div>
    </>
  );
}

/**
 * The series, as TEXT and as a bar per point. No SVG path, no interpolation between points:
 * each point is one measurement, and a gap between two of them is a gap in the record, not a
 * straight line. `discrete` is stated on screen rather than only in the markup, because a
 * reader who is looking at a chart of survey counts deserves to know they are survey counts.
 */
function FeatureSeriesChart({
  series,
}: {
  readonly series: NonNullable<FeatureDetail['series']>;
}): JSX.Element {
  const values = series.points.map((point) => point.value);
  const max = values.reduce<number>((best, value) => (value === null ? best : Math.max(best, value)), 0);
  const scale = max > 0 ? max : 1;

  return (
    <div className="eoy-series">
      <h3 className="eoy-sheet__section-title">{series.title}</h3>
      <ul className="eoy-series__bars">
        {series.points.map((point) => (
          <li className="eoy-series__row" key={point.label}>
            <span className="eoy-series__label">{point.label}</span>
            <span
              className="eoy-series__bar"
              style={{
                inlineSize: `${point.value === null ? 0 : Math.round((point.value / scale) * 100)}%`,
              }}
              aria-hidden="true"
            />
            <span className="eoy-series__value">
              {point.value === null ? 'not surveyed' : `${point.value.toLocaleString('en-US')} ${series.unit}`}
            </span>
          </li>
        ))}
      </ul>
      {series.discrete ? (
        <p className="eoy-series__note">
          Each bar is one survey on its own date. Nothing is drawn between them, because
          nothing was measured between them.
        </p>
      ) : null}
    </div>
  );
}
