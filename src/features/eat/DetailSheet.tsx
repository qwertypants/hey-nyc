/**
 * The detail sheet. Everything this app knows about one place, and nothing it does not.
 *
 * THE HONESTY RULE. There are no hours, no rating, no price, no menu, no phone, no seating
 * and no "open now" in the source (docs/data-dictionary.md §2), so none of them appear
 * here — not greyed out, not as "coming soon". An empty field invites the reader to supply
 * the value themselves, and on a dining licence that means guessing. What IS there is the
 * one operational fact DOT publishes: roadway licences may only operate April 1 – November
 * 29, which is exactly the thing a person standing outside in January needs.
 *
 * Structure:
 * - `role="dialog"` + `aria-modal`, because the rest of the app is set `inert` while this is
 *   open, so the claim is true. Focus is trapped (see `useFocusTrap`), Escape closes, and
 *   focus returns to whatever opened it — usually the list row that got them here.
 * - Dining type is a real list with a check mark per applicable licence. A `both` place gets
 *   TWO rows, because that is the truth: it holds two licences. The row carries the label
 *   from `describeType`, a swatch that repeats the map's shape, and the shape's description
 *   in words, so the type survives greyscale and a screen reader.
 * - The provenance line is built from `formatUpdatedAt(metadata)`, never a literal date, and
 *   it disappears entirely when metadata is missing rather than showing a placeholder.
 * - The licence dates come from `formatLicensePeriod`, which already degrades gracefully
 *   when either bound is missing.
 *
 * The grip at the top is a drag AFFORDANCE, not a drag CONTROL. Nothing here requires a
 * pointer to dismiss: the close button, Escape and clicking the scrim all work.
 */

import type { JSX } from 'react';
import { useId, useRef } from 'react';
import type { DatasetMetadata, DiningType, LocationProperties } from '../../types/location';
import { describeType, typeStyle } from '../../map/style';
import type { LatLng } from '../../lib/distance';
import { describeDistance } from '../../lib/distance';
import {
  formatAddressLines,
  formatLicensePeriod,
  formatUpdatedAt,
  roadwaySeasonNote,
} from '../../lib/format';
import { DATA_ATTRIBUTION_HTML } from '../../lib/attribution';
import { DirectionsLink, directionsTargetFor } from '../../components/DirectionsLink';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import { CheckIcon, CloseIcon, MapIcon } from '../../components/icons';

/** `both` really is two licences, so the sheet lists two rows. */
function applicableTypes(type: DiningType): readonly DiningType[] {
  return type === 'both' ? ['sidewalk', 'roadway'] : [type];
}

export interface DetailSheetProps {
  readonly location: LocationProperties;
  readonly coords: LatLng;
  readonly metadata: DatasetMetadata | null;
  /** The visitor's fix, or null. The only legal origin for a distance. */
  readonly origin: LatLng | null;
  readonly onClose: () => void;
  /** Rendered as a secondary action only when the list is covering the map. */
  readonly onShowOnMap?: () => void;
}

export function DetailSheet({
  location,
  coords,
  metadata,
  origin,
  onClose,
  onShowOnMap,
}: DetailSheetProps): JSX.Element {
  const sheetRef = useRef<HTMLDivElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const titleId = useId();

  useFocusTrap(sheetRef, { active: true, onEscape: onClose, initialFocus: closeRef });

  const types = applicableTypes(location.type);
  const seasonNote = roadwaySeasonNote(location.type);
  const distance = describeDistance(origin, coords);
  const updatedAt = formatUpdatedAt(metadata);

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
            {location.name}
          </h2>
          <p className="eoy-sheet__legal">{location.legalName}</p>
        </div>
        <button
          type="button"
          className="eoy-sheet__close"
          ref={closeRef}
          onClick={onClose}
        >
          <CloseIcon />
          <span className="eoy-visually-hidden">Close details for {location.name}</span>
        </button>
      </div>

      <div className="eoy-sheet__body">
        <address className="eoy-sheet__address">
          {formatAddressLines(location).map((line) => (
            <span key={line} className="eoy-sheet__address-line">
              {line}
            </span>
          ))}
        </address>

        {distance === null ? null : <p className="eoy-sheet__meta">{distance} from you</p>}

        <h3 className="eoy-sheet__section-title">Dining type</h3>
        <ul className="eoy-type-list">
          {types.map((type) => {
            const style = typeStyle(type);
            return (
              <li className="eoy-type-list__item" key={type}>
                <span className="eoy-type-list__check" aria-hidden="true">
                  <CheckIcon size={13} />
                </span>
                <span>
                  {describeType(type)}
                  <span className="eoy-type-list__shape">
                    <span
                      className={`eoy-legend-item__shape eoy-legend-item__shape--${style.shape}`}
                      aria-hidden="true"
                    />{' '}
                    Shown on the map as a {style.shapeDescription.toLowerCase()}.
                  </span>
                </span>
              </li>
            );
          })}
        </ul>

        {seasonNote === null ? null : (
          <p className="eoy-sheet__note">{seasonNote}</p>
        )}

        <h3 className="eoy-sheet__section-title">Licence</h3>
        <p className="eoy-sheet__meta">{formatLicensePeriod(location)}</p>
        <p className="eoy-sheet__meta">Status: {location.status}</p>

        <div className="eoy-sheet__actions">
          <DirectionsLink
            target={directionsTargetFor(location, coords)}
            options={{ origin }}
          />
          {onShowOnMap === undefined ? null : (
            <button type="button" className="eoy-button" onClick={onShowOnMap}>
              <MapIcon />
              Show on map
            </button>
          )}
        </div>

        <p className="eoy-sheet__attribution">
          NYC Dining Out data{updatedAt === null ? '' : ` · ${updatedAt}`}
        </p>
        <p
          className="eoy-sheet__attribution"
          // Static literal with no interpolated user data — see src/lib/attribution.ts.
          dangerouslySetInnerHTML={{ __html: DATA_ATTRIBUTION_HTML }}
        />
      </div>
    </div>
  );
}
