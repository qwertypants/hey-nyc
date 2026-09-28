# Data dictionary — `fpeh-f7ci` "Dining Out NYC Locations"

**Everything in this document was measured against the live dataset on 2026-09-27, not
inferred from a specification.** Counts are the exact numbers observed at that time and
are re-measured on every refresh by `scripts/inspect_data.py`.

- **Dataset:** [Dining Out NYC Locations](https://data.cityofnewyork.us/Transportation/Dining-Out-NYC-Locations/fpeh-f7ci)
- **Dataset ID:** `fpeh-f7ci`
- **Provider:** New York City Department of Transportation (NYC DOT)
- **Source API:** `https://data.cityofnewyork.us/resource/fpeh-f7ci.json` (Socrata v2.1, no key required)
- **Attribution:** "Department of Transportation (DOT)" per the dataset metadata
- **Published by:** automated, **daily** ("Date Made Public: 1/21/2026")
- **Row label:** "food service establishment that is participating in the Dining Out NYC program."
- **CRS:** WGS84 decimal degrees. The official data dictionary states records were
  "geocoded using the New York-Long Island zone, North American Datum of 1983 (NAD 83)
  projected coordinate system" and published as `latitude` / `longitude` decimal degrees.

---

## 1. Headline numbers (2026-09-27)

| Measure | Value |
| --- | --- |
| Source rows (licences) | **2 437** |
| Rejected rows | 6 |
| Rows surviving validation | 2 431 |
| **Published establishments** | **2 000** |
| `type: "sidewalk"` | 1 173 |
| `type: "roadway"` | 396 |
| `type: "both"` (derived) | 431 |
| Boroughs represented | 5 of 5 |

> The source publishes **one row per licence**, not one row per business. See §5.

---

## 2. Every column, and whether Eat Outside NYC uses it

`present` = non-null in at least one row. `nulls` = rows where the key is absent or null.

| # | API field name | Label | Type | present | nulls | Used? | Why / why not |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | `business_legal_name` | Business Legal Name | text | 2437 | 0 | **yes** → `legalName` | Registered entity name. Shown as secondary text; also half of the stable ID. |
| 2 | `assumed_name_s` | Assumed Name(s) | text | 2437 | 0 | **yes** → `name` | The name the public recognises ("SWEETGREEN"). Source stores it UPPERCASE; we publish it verbatim and never case-fold source text. |
| 3 | `street` | Street | text | 2437 | 0 | **yes** → `street` | House number + street. |
| 4 | `city` | City | text | 2437 | 0 | **yes** → `neighborhood` | **Misleading name — this is a neighbourhood, not a city.** Values: `NEW YORK`, `BROOKLYN`, `ASTORIA`, `FOREST HILLS`, `JERSEY CITY`, `AMITYVILLE`, … The dictionary's own example is `e.g., "FOREST HILLS")`. Used for local search and for spotting out-of-city records. |
| 5 | `borough` | Borough | text | 2433 | 4 | **yes** → `borough` | Borough filter. The 4 nulls are 2 Jersey City NJ and 2 Amityville NY establishments — the only records outside the program. |
| 6 | `postcode` | Postcode | text | 2437 | 0 | **yes** → `zip` | 5 digits. Leading zeros are preserved as strings (`07307` for Jersey City). Not used as a validity gate — see §6. |
| 7 | `license_type` | License Type | text | 2437 | 0 | **yes** → `type` | Exactly two values: `Sidewalk` (1607 rows), `Roadway` (830 rows). Drives map colour and the dining-type filter. |
| 8 | `license_status` | License Status | text | 2437 | 0 | **yes** → `status` | Dictionary expects `Issued` / `Expired`. **Currently `Issued` for all 2 437 rows**, so there is zero variance and **no status filter is shipped** — a one-value filter is a lie. `validate_data.py` watches for drift. |
| 9 | `license_issue_date` | License Issue Date | calendar_date | 2436 | 1 | **yes** → `licenseIssued` | `YYYY-MM-DDTHH:MM:SS.mmm`. Truncated to a calendar date for display. |
| 10 | `license_expiration_date` | License Expiration Date | calendar_date | 2436 | 1 | **yes** → `licenseExpires` | Earliest observed 2028-10-09. Truncated to a calendar date. |
| 11 | `latitude` | Latitude | number | 2437 | 0 | **yes** → geometry | 10–12 significant digits. Validated against an NYC bounding box. |
| 12 | `longitude` | Longitude | number | 2437 | 0 | **yes** → geometry | As above. |
| 13 | `council_district` | Council District | number | 2437 | 0 | no | Useful, but no filter and no UI surface is justified in the MVP. Available in raw for later. |
| 14 | `community_board` | Community Board | number | 2437 | 0 | no | As above. |
| 15 | `bin` | BIN | number | 2407 | 30 | no | 7-digit building id. 30 nulls, so unusable as a key. |
| 16 | `bbl` | BBL | number | 2411 | 26 | **yes** → `bbl` | Borough-block-lot. Useful provenance for a location. Degenerate values (`1`, `3`) appear and are normalised to `null`. |
| 17 | `ct2020` | Census Tract (2020) | number | 2430 | 7 | no | Leading zeros are stripped by the geocoder. |
| 18 | `nta2020` | NTA (2020) | text | 2430 | 7 | **yes** → `nta` | e.g. `BK0204`. **6 characters** — a 2-letter borough prefix plus 4 digits. Cheap, and the hook for future neighbourhood filtering. |
| 19 | `location` | Location | point | 2437 | 0 | no | Socrata's GeoJSON point for the map lens. Verified byte-for-byte consistent with `latitude`/`longitude` in all 2437 rows. We rebuild the geometry ourselves from the two scalar columns. |
| 20 | `:@computed_region_92fq_4b7q` | City Council Districts | number | 2430 | 7 | no | Socrata spatial-join artifact. |
| 21 | `:@computed_region_f5dn_yrer` | Community Districts | number | 2430 | 7 | no | Socrata spatial-join artifact. |
| 22 | `:@computed_region_yeji_bk3q` | Borough Boundaries | number | 2430 | 7 | no | Socrata spatial-join artifact. |
| 23 | `:@computed_region_sbqj_enih` | Police Precincts | number | 2430 | 7 | no | Socrata spatial-join artifact. |
| — | `:id` | *(system)* | — | 2437 | 0 | **yes** → `sid` | Not in the column list, but Socrata exposes it. **Verified unique across all 2 437 rows.** Kept for traceability back to the canonical source. |

### Columns that do not exist

The original product brief speculated about several fields. **None of them are in this
dataset**, so none are implemented, and nothing stands in for them:

- seating capacity, number of tables, café dimensions, square footage
- hours of operation, cuisine, price range, menu, photos
- ratings, reviews, reservation availability
- separate `sidewalk` / `roadway` booleans (there is one `license_type` enum instead)
- any licence number, permit id, or application id
- a human-readable NTA name (only the code, e.g. `MN0502`)

---

## 3. Official field limitations (verbatim from the city's data dictionary)

> "Food establishments may be listed twice for sidewalk and roadway café licenses."

> "Sidewalk: license may be operated year-round on sidewalks"
> "Roadway: roadway cafes may operate from April 1 through November 29"

Both facts are load-bearing:

1. Duplicate-looking rows are **legitimate** and must be merged, not deduplicated away.
2. `Roadway` locations carry a **seasonal window** that a user standing there in January
   needs to know. The detail sheet states it.

---

## 4. The `both` value is derived, never invented

There is no `Both` row in `license_type`. The product needs one, so the pipeline derives it
by grouping rows that share `business_legal_name` + `street`.

**Measured, 2026-09-27:**

- 2 004 distinct `(business_legal_name, street)` pairs exist across all 2 437 rows.
- Group sizes are only ever **1 or 2**. No group has 3+ rows.
- **All 433 two-row groups contain exactly one `Sidewalk` and one `Roadway` row.**
- **All 433 two-row groups have byte-identical coordinates** (not merely "close").
- **Zero groups have two rows of the same `license_type`.**
- **Zero rows are exact duplicates across all 23 fields.**

So the merge is unambiguous, and 2 437 rows collapse to 2 004 establishments — of which
2 000 survive the geographic and borough validation in §6.

`legalName + street + license_type` is unique across all 2 437 rows, which independently
confirms the grouping key. The resulting establishment-level type distribution is
**1 173 sidewalk / 396 roadway / 431 both**.

---

## 5. Why not use `bin` or `bbl` as the stable ID

| Candidate key | Distinct | Duplicate rows |
| --- | --- | --- |
| `bbl` | 1 840 | 597 |
| `bin` | 1 852 | 585 |
| `bbl` + `license_type` | 2 271 | 166 |
| `business_legal_name` + `street` | 2 004 | 433 (the legitimate both-pairs) |
| **`business_legal_name` + `street` + `license_type`** | **2 437** | **0** |

`bbl` identifies a *parcel*, so many unrelated businesses share one. It cannot be a
location key.

**The published `id` is `eoy-` + the first 12 hex characters of
`sha1("<business_legal_name>|<street>")`.** Chosen because it is:

- **deterministic** — same input, same id, on any machine, in any order;
- **stable across refreshes** — it does not depend on Socrata row order or `:id`;
- **order-independent** — two refreshes that differ only in row order produce identical
  output, which is what makes commit-skipping work;
- **collision-free at this scale** — 2 000 ids, 0 collisions.

Caveat, documented in the README: if DOT corrects a business name or address, that
establishment's `id` changes. These are not durable database keys, and we do not
pretend otherwise.

---

## 6. Validation rules, and what they reject

Two independent rules, both derived from the dataset's own self-consistency. The
pipeline never silently repairs anything: a record that fails is **rejected and named in
`report.json`**.

### Rule 1 — coordinates must fall inside New York City

Bounding box used: **lat 40.40 → 41.00, lng −74.30 → −73.65.** Padded well beyond the
observed data extent (lat 40.574–40.910, lng −74.144 to −73.720 once the outlier is
removed) so that normal geocoder jitter is never mistaken for corruption.

The box's eastern limit of −73.65 is doing real work. `MOULINAS LLC` / `BAR TABAC` is
listed at `128 SMITH STREET, AMITYVILLE 11701` with coordinates `40.6907, −73.4137` —
roughly 20 km **offshore in the Atlantic**, east of Coney Island and nowhere near a
Suffolk County address. On its own, that longitude is caught by this rule.

### Rule 2 — `borough` must be one of the five NYC boroughs

Allowed values are fixed by the city's own dictionary:
`Queens, Brooklyn, Manhattan, Bronx, Staten Island`.

Rejects the two Jersey City establishments, whose `borough` is null and whose `postcode`
(`07307`) is a New Jersey ZIP.

`postcode` is deliberately **not** a validity gate. `borough` is the more reliable field —
one Manhattan record carries a `113` prefix and two Queens records carry `114` — so using
postcode as a hard rule would reject good data.

### Why the report says `outOfBounds: 2, unknownBorough: 4`

Both rules are evaluated, and the **most meaningful** reason is the one reported, ranked
`unknown_borough` above `out_of_bounds`. A null `borough` means the record is not in the
program at all, which is a truer statement than "its longitude looked odd". The secondary
failure is still named in the rejection text, and `inspect_data.py` reports the raw
unfiltered count (4 out of box) so nothing is hidden.

Net: **2 437 rows → 6 rejected → 2 431 → 2 000 published establishments.**

| Public name (`assumed_name_s`) | `city` | `postcode` | Coordinates | Why rejected |
| --- | --- | --- | --- | --- |
| `ENZO'S OF ARTHUR AVE` (×2 rows) | `BRONX` | — | 42.1264, −70.8481 | Geocoded to **Boston, Massachusetts**. `borough` says `Bronx`. |
| `BAR TABAC` (×2 rows) | `AMITYVILLE` | `11701` | 40.6907, −73.4137 | Suffolk County address, `borough` null, and the coordinates are offshore. |
| `MADELINE'S` | `JERSEY CITY` | `07307` | 40.7425, −74.0497 | **Jersey City, New Jersey.** `borough` null. |
| `SERENECO` | `JERSEY CITY` | `07307` | 40.7425, −74.0497 | **Jersey City, New Jersey.** `borough` null. |

The Jersey City pair is the interesting case: its coordinates sit *inside* the NYC bounding
box, so only the borough rule catches it.

Names above are the public `assumed_name_s`, which is what a person would recognise.
`report.json` follows the same rule as the published artifact and lists `assumed_name_s`
first.

### Other dirt found, and how it is handled

- **Internal whitespace runs in 341 rows** — 329 in `street` (`86 EAST    7 STREET`) and
  12 in `business_legal_name` (`GIN BLOSSOM BK  LLC`), covering 290 distinct
  establishments. This is load-bearing rather than cosmetic: whitespace is collapsed
  **before** the id is hashed, so a business cannot receive two different ids depending on
  which row you hashed. Counted as `report.pipeline.whitespaceCollapsed`.
- **`bbl` is not always 10 digits.** Genuine values of `18830048` (8 digits) and
  `115510024` (9 digits) exist, alongside the genuinely degenerate `1` and `3`. Defining
  "degenerate" as "not exactly 10 digits" would silently delete two real parcels, so the
  floor is **5 digits** (`BBL_MIN_DIGITS` in `scripts/_common.py`); `1` and `3` are
  normalised to `null` and counted. 19 published features have `bbl: null`.
- **7 rows are missing `ct2020`, `nta2020` and all four computed-region columns** — the
  6 rejected rows plus **`LA CHOZA DEL GORDO` in Bellerose, Queens**, which *is* published
  with `nta: null`. The missing administrative geography is therefore **not** a reliable
  proxy for "not in the program".
- **Names keep the source's UPPERCASE form.** The source publishes it that way; the UI may
  style it, the data does not lie about it.
- **`$select` must name `:id` explicitly.** `*,:id` silently drops the four
  `:@computed_region_*` columns, so `fetch_data.py` discovers the column list from
  `/api/views/fpeh-f7ci.json` and appends them. The stored raw snapshot is 24 keys: the
  23 documented columns plus `:id`.

---

## 7. Published GeoJSON schema

`public/data/cafes.geojson` — a `FeatureCollection` of 2 000 `Point` features.

The client artifact is deliberately **minimal**. Fourteen properties, chosen because the
product renders or filters on each one. The 23 source columns are not copied wholesale.

```jsonc
{
  "type": "Feature",
  "id": "eoy-3f2a1b9c4d5e",
  "geometry": { "type": "Point", "coordinates": [-73.966407027011, 40.683381422171] },
  "properties": {
    "id": "eoy-3f2a1b9c4d5e",
    "name": "EMMY",                 // assumed_name_s, else business_legal_name
    "legalName": "EMH 919 INC",     // business_legal_name
    "street": "919 FULTON STREET",
    "neighborhood": null,           // city — null when the source has no value
    "borough": "Brooklyn",
    "zip": "11238",
    "type": "sidewalk",             // sidewalk | roadway | both  (both = derived)
    "status": "Issued",             // license_status
    "licenseIssued": "2026-06-12",  // date only
    "licenseExpires": "2030-06-12", // date only
    "nta": "BK0204",
    "bbl": "3019770033",
    "sid": ["row-id-from-socrata"]  // :id of the source row(s)
  }
}
```

The TypeScript mirror of this contract is `src/types/location.ts`. **Both must change
together.** `scripts/validate_data.py` asserts the artifact against it, and
`tests/smoke` asserts the same shape at the TypeScript boundary.

`public/data/metadata.json` carries provenance and counts so the UI can render
"Data updated Sep 27" without a hard-coded date. It includes a `contentHash` —
sha256 over canonicalised records — which is how the daily workflow skips pointless
commits when the upstream records have not changed.

---

## 8. Attribution requirement

Every screen that shows the map, and the README, must carry:

> Data from **NYC Open Data** — "Dining Out NYC Locations" (`fpeh-f7ci`), provided by the
> **NYC Department of Transportation**.

Plus the basemap attribution required by §15 of the product brief. See
`docs/basemap.md`.
