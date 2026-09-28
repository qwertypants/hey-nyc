#!/usr/bin/env python3
"""Assert the published walk artifacts against src/types/walk.ts.

Two failure classes, kept apart exactly as in scripts/validate_data.py:

* **Corruption** — a published id that does not match the recipe, two features
  sharing a `counterSerial`, a `count` on an offline counter, an `expected`
  computed from fewer than MIN_SAMPLES observations, a property of the wrong
  type, a coordinate outside the bbox. Always fatal.
* **Drift** — a new `borough`, `granularity`, `direction` or `status` upstream.
  Loud, non-fatal, because the app degrades gracefully.

THE TWIN-COLLAPSE INVARIANT
==========================
A twin that failed to collapse does not look broken. It looks like a map with
eight points instead of four, every one of them plausible. So the interesting
checks here are not "is this file well formed" but "is this the same
measurement, counted once":

  I1  no two published features share a `counterSerial`
  I2  every source `sensor_id` appears in exactly one feature's `sensorIds`, so
      no counter is published twice and none is split in half
  I3  each feature's `count` equals the sum of in+out over the raw rows of its
      REPRESENTATIVE sensor id at its `observedAt` — recomputed here from the
      snapshot, not read from the build
  I4  the twin-unaware aggregate for that counter (every source id it lists)
      equals `count x len(sensorIds)`, which is the statement that the twins
      are byte-identical duplicates AND that the published total is not 2x it

I3 and I4 are the same measurement seen from both sides. I3 would fail if the
build summed the wrong series; I4 fails if the twins ever diverge, which is
the assumption the whole model rests on. The live measured figure: summing all
1,505,220 pedestrian rows gives 7,484,824, and the physical total is 3,742,412.

Usage:
    python3 scripts/walk/validate_walk.py [--strict] [--min-sensors N] [--out-dir DIR]
"""

from __future__ import annotations

import argparse
import importlib.util
import math
import sys
from collections import Counter as Tally
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

if "walk_common" not in sys.modules:
    _spec = importlib.util.spec_from_file_location(
        "walk_common", Path(__file__).resolve().parent / "_common.py"
    )
    _walk_common = importlib.util.module_from_spec(_spec)
    sys.modules["walk_common"] = _walk_common
    _spec.loader.exec_module(_walk_common)
C = sys.modules["walk_common"]

#: Fewer published counters than this means the build lost a counter rather than
#: reporting a real one. 2026-09-28 measured 4 physical counters, 2 reporting.
MIN_SENSORS = 2

#: `status` is constant (`raw`) for every pedestrian row in the source, so a new
#: value here is upstream drift worth seeing and not a corruption: freshness is
#: derived from the age of the newest observation, never from this column.
KNOWN_COUNT_STATUSES = set(C.COUNT_STATUSES)


@dataclass
class Result:
    errors: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    stats: dict[str, Any] = field(default_factory=dict)

    def error(self, message: str) -> None:
        self.errors.append(message)

    def warn(self, message: str) -> None:
        self.warnings.append(message)

    def note_drift(self, message: str) -> None:
        self.warnings.append(f"SCHEMA DRIFT: {message}")


def _is_integer(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


# --------------------------------------------------------------------------- geojson


def check_features(geojson: Any, result: Result) -> list[dict]:
    if not isinstance(geojson, dict):
        result.error(f"sensors.geojson must be a JSON object, got {C.js_kind(geojson)}")
        return []
    if geojson.get("type") != "FeatureCollection":
        result.error(f"sensors.geojson type is {geojson.get('type')!r}, expected 'FeatureCollection'")
    features = geojson.get("features")
    if not isinstance(features, list):
        result.error("sensors.geojson features must be an array")
        return []

    seen_ids: dict[str, int] = {}
    seen_serials: dict[str, str] = {}
    seen_source_ids: dict[str, str] = {}
    activity: Tally = Tally()
    staleness: Tally = Tally()
    twins: Tally = Tally()
    unknown_boroughs: Tally = Tally()
    granularities: Tally = Tally()

    for index, feature in enumerate(features):
        where = f"feature[{index}]"
        if not isinstance(feature, dict):
            result.error(f"{where} is {C.js_kind(feature)}, expected an object")
            continue
        if feature.get("type") != "Feature":
            result.error(f"{where}.type is {feature.get('type')!r}, expected 'Feature'")

        geometry = feature.get("geometry")
        if not isinstance(geometry, dict) or geometry.get("type") != "Point":
            result.error(f"{where}.geometry must be a Point")
        else:
            coordinates = geometry.get("coordinates")
            if (
                not isinstance(coordinates, list)
                or len(coordinates) != 2
                or not all(isinstance(c, (int, float)) and math.isfinite(c) for c in coordinates)
            ):
                result.error(f"{where}.geometry.coordinates must be two finite numbers")
            else:
                lon, lat = coordinates
                if not C.in_nyc_bbox(lat, lon):
                    result.error(
                        f"{where} coordinates {lon},{lat} are outside the NYC bounding box "
                        f"lat[{C.LAT_MIN},{C.LAT_MAX}] lng[{C.LNG_MIN},{C.LNG_MAX}]"
                    )

        properties = feature.get("properties")
        if not isinstance(properties, dict):
            result.error(f"{where}.properties must be an object")
            continue

        for name in C.SENSOR_PROPERTY_ORDER:
            if name not in properties:
                result.error(f"{where}.properties is missing {name!r}")
        for name in properties:
            if name not in C.SENSOR_PROPERTY_ORDER:
                result.error(
                    f"{where}.properties has unexpected key {name!r}; "
                    f"SENSOR_PROPERTY_ORDER and src/types/walk.ts must change together"
                )
        if list(properties) != [name for name in C.SENSOR_PROPERTY_ORDER if name in properties]:
            result.error(f"{where}.properties is not in SENSOR_PROPERTY_ORDER order")
        for name, allowed in C.SENSOR_PROPERTY_TYPES.items():
            if name in properties:
                kind = C.js_kind(properties[name])
                if kind not in allowed:
                    result.error(
                        f"{where}.properties.{name} is {kind}, expected one of {list(allowed)}"
                    )

        sensor_id = properties.get("id")
        serial = properties.get("counterSerial")
        if isinstance(sensor_id, str):
            if not C.SENSOR_ID_RE.match(sensor_id):
                result.error(
                    f"{where} id {sensor_id!r} does not match {C.SENSOR_ID_RE.pattern}"
                )
            if sensor_id in seen_ids:
                result.error(f"duplicate id {sensor_id!r} at features {seen_ids[sensor_id]} and {index}")
            else:
                seen_ids[sensor_id] = index
            if feature.get("id") != sensor_id:
                result.error(f"{where}.id {feature.get('id')!r} != properties.id {sensor_id!r}")
        if isinstance(serial, str):
            if serial in seen_serials:
                # I1: one physical counter, published twice. The twin collapse
                # failed, which doubles the volume on any aggregate.
                result.error(
                    f"{where} counterSerial {serial!r} is already published by feature "
                    f"{seen_serials[serial]}; a twin failed to collapse"
                )
            else:
                seen_serials[serial] = sensor_id if isinstance(sensor_id, str) else where
            if isinstance(sensor_id, str) and sensor_id != C.sensor_id(serial):
                result.error(
                    f"{where} id {sensor_id!r} is not sha1(counterSerial {serial!r}); "
                    f"expected {C.sensor_id(serial)!r}"
                )

        source_ids = properties.get("sensorIds")
        if isinstance(source_ids, list):
            if not source_ids:
                result.error(f"{where}.properties.sensorIds is empty")
            elif not all(isinstance(value, str) and value for value in source_ids):
                result.error(f"{where}.properties.sensorIds must be strings")
            else:
                if len(source_ids) != len(set(source_ids)):
                    result.error(f"{where}.properties.sensorIds has a repeat")
                if list(source_ids) != sorted(source_ids):
                    result.error(f"{where}.properties.sensorIds must be sorted")
                twins[len(source_ids)] += 1
                for value in source_ids:
                    if value in seen_source_ids:
                        result.error(
                            f"source sensor_id {value!r} published twice "
                            f"({seen_source_ids[value]} and {sensor_id})"
                        )
                    else:
                        seen_source_ids[value] = str(sensor_id)
        else:
            result.error(f"{where}.properties.sensorIds must be an array")

        # --- freshness and the numbers that hang off it
        state = properties.get("staleness")
        if isinstance(state, str):
            if state not in C.STALENESS_STATES:
                result.error(
                    f"{where}.properties.staleness {state!r} is not one of {list(C.STALENESS_STATES)}"
                )
            else:
                staleness[state] += 1
        label = properties.get("activity")
        if isinstance(label, str):
            if label not in C.ACTIVITY_BUCKETS:
                result.error(
                    f"{where}.properties.activity {label!r} is not one of {list(C.ACTIVITY_BUCKETS)}"
                )
            else:
                activity[label] += 1

        count = properties.get("count")
        expected = properties.get("expected")
        percentile = properties.get("percentile")
        ratio = properties.get("ratio")
        samples = properties.get("observationCount")
        observed_at = properties.get("observedAt")

        for name, value in (("count", count), ("expected", expected), ("percentile", percentile)):
            if value is None:
                continue
            if not _is_integer(value):
                result.error(f"{where}.properties.{name} must be an integer or null, got {value!r}")
            elif value < 0:
                result.error(f"{where}.properties.{name} is negative ({value})")
        if ratio is not None and (isinstance(ratio, bool) or not isinstance(ratio, (int, float))):
            result.error(f"{where}.properties.ratio must be a number or null, got {ratio!r}")
        if not _is_integer(samples):
            result.error(f"{where}.properties.observationCount must be an integer, got {samples!r}")
        elif samples < 0:
            result.error(f"{where}.properties.observationCount is negative ({samples})")
        if observed_at is not None and not (
            isinstance(observed_at, str) and observed_at.endswith("Z")
        ):
            result.error(
                f"{where}.properties.observedAt must be ISO-8601 UTC ending in Z, got {observed_at!r}"
            )

        # A number published from too little history is a confident guess.
        if _is_integer(samples) and samples < C.MIN_SAMPLES:
            for name, value in (("expected", expected), ("percentile", percentile)):
                if value is not None:
                    result.error(
                        f"{where}.properties.{name} is {value} but observationCount is {samples}, "
                        f"below MIN_SAMPLES={C.MIN_SAMPLES}; the baseline is unavailable"
                    )
            if label != "unavailable" and isinstance(label, str):
                result.error(
                    f"{where}.properties.activity is {label!r} with only {samples} observation(s); "
                    "it must be 'unavailable' below MIN_SAMPLES"
                )
        if _is_integer(samples) and samples >= C.MIN_SAMPLES and expected is None and count is not None:
            result.error(
                f"{where} has {samples} observations but no expected value; the baseline was not computed"
            )

        # THE ZERO-BASELINE RULE, recomputed from the published properties.
        # `activity_for` in _common.py applies a rule the percentile ladder
        # cannot express: a bucket whose expected value is 0 has no established
        # pedestrian volume, so no level on the ladder means anything for it.
        # Checking it here, from `expected`/`count`/`activity` alone, is what
        # stops the build and the contract drifting apart — and it is possible
        # only because the rule is keyed on the PUBLISHED rounded median rather
        # than on the raw one, which the validator cannot see.
        #
        # 60.6% of real baseline keys have a median of exactly 0, so this is the
        # majority path, not an edge case: without the rule the map labels a
        # Monday-01:00 park path "typical" when the median observation in its
        # own history is that nobody was there.
        if _is_integer(expected) and expected == 0 and count is not None:
            wanted = "quiet" if count == 0 else "unavailable"
            if label != wanted:
                result.error(
                    f"{where}.properties.activity is {label!r} with expected=0 and count={count}; "
                    f"a zero-expected bucket must be {wanted!r} (see _common.activity_for — a "
                    "level there would assert foot traffic the bucket's own median says it does not have)"
                )
        # ...and the converse, so a label can never be published on top of a
        # baseline with no established volume. `quiet` is NOT forbidden: it
        # claims nothing about volume and is the label the rule asks for. The
        # forbidden set is derived from ACTIVITY_CUTS in the contract so this
        # check and the rule cannot drift apart.
        if isinstance(label, str) and label in C.ACTIVITY_LEVELS_REQUIRING_VOLUME and expected == 0:
            result.error(
                f"{where}.properties.activity is {label!r} but expected is 0; "
                f"{', '.join(C.ACTIVITY_LEVELS_REQUIRING_VOLUME)} all assert a foot traffic this "
                "bucket's own median says it does not have"
            )
        if expected == 0 and ratio is not None:
            result.error(
                f"{where}.properties.ratio is {ratio!r} with expected=0; there is no ratio to publish"
            )

        # A dead counter must not carry a live-looking number.
        if state in ("offline", "unavailable"):
            for name, value in (("count", count), ("expected", expected), ("percentile", percentile), ("ratio", ratio)):
                if value is not None:
                    result.error(
                        f"{where}.properties.{name} is {value!r} on a {state} counter; "
                        "a counter with no recent reading publishes null, not a stale number"
                    )
        if state == "fresh":
            if observed_at is None or count is None:
                result.error(
                    f"{where} is fresh but has observedAt={observed_at!r} count={count!r}; "
                    "freshness is derived from the newest observation, so both must exist"
                )
        # `observedAt` is documented as the instant `count` came from, so the two
        # are never independently null.
        if (count is None) != (observed_at is None):
            result.error(
                f"{where} has count={count!r} with observedAt={observed_at!r}; a null count and a "
                "null observedAt must go together (use lastObservation for when a dead counter last spoke)"
            )
        if properties.get("active") is not (state == "fresh"):
            result.error(
                f"{where}.properties.active is {properties.get('active')!r} but staleness is {state!r}; "
                "active must be exactly staleness == 'fresh'"
            )

        if ratio is not None and isinstance(ratio, (int, float)) and not isinstance(ratio, bool):
            if isinstance(count, int) and isinstance(expected, int) and expected > 0:
                if abs(ratio - count / expected) > 0.005:
                    result.error(
                        f"{where}.properties.ratio {ratio} != count/expected ({count / expected:.3f})"
                    )
            elif count is None or expected is None or expected == 0:
                result.error(
                    f"{where}.properties.ratio {ratio!r} needs both a count and a non-zero expected value"
                )
        elif ratio is None and isinstance(count, int) and isinstance(expected, int) and expected > 0:
            result.error(
                f"{where}.properties.ratio is null although count={count} and expected={expected}"
            )
        if percentile is not None and isinstance(percentile, int) and not 0 <= percentile <= 100:
            result.error(f"{where}.properties.percentile {percentile} is outside 0..100")

        borough = properties.get("borough")
        if isinstance(borough, str) and borough not in C.BOROUGHS:
            unknown_boroughs[borough] += 1
        granularity = properties.get("granularity")
        if isinstance(granularity, str):
            if granularity not in C.GRANULARITIES:
                granularities[granularity] += 1
            elif not granularity:
                result.error(f"{where}.properties.granularity is empty; the source always publishes one")

    for value, count in sorted(unknown_boroughs.items()):
        result.note_drift(f"unknown borough {value!r} x{count}; known: {list(C.BOROUGHS)}")
    for value, count in sorted(granularities.items()):
        if value:
            result.note_drift(
                f"granularity {value!r} x{count}; the source publishes {list(C.GRANULARITIES)}"
            )
    if any(multi > 1 for multi in twins):
        result.warn(
            f"twinCount histogram {dict(sorted(twins.items()))}: a counter with more than one "
            "sensor_id is normal (each is published twice) and is collapsed on counters_serial"
        )
    result.stats.update(
        sensorCount=len(features),
        uniqueIds=len(seen_ids),
        uniqueSerials=len(seen_serials),
        uniqueSourceIds=len(seen_source_ids),
        activity={key: activity.get(key, 0) for key in C.ACTIVITY_BUCKETS},
        staleness={key: staleness.get(key, 0) for key in C.STALENESS_STATES},
        twinCount={str(key): value for key, value in sorted(twins.items())},
    )
    return features


# --------------------------------------------------------------------------- latest.json


def check_latest(latest: Any, features: list[dict], result: Result) -> None:
    if not isinstance(latest, dict):
        result.error(f"latest.json must be a JSON object, got {C.js_kind(latest)}")
        return
    for key in ("latestObservation", "contentHash", "sensors"):
        if key not in latest:
            result.error(f"latest.json is missing {key!r}")
    rows = latest.get("sensors")
    if not isinstance(rows, list):
        result.error("latest.json.sensors must be an array")
        return
    if len(rows) != len(features):
        result.error(
            f"latest.json has {len(rows)} sensors but sensors.geojson has {len(features)}"
        )
    published = {
        feature["properties"]["id"]: feature["properties"]
        for feature in features
        if isinstance(feature.get("properties"), dict)
    }
    observed: list[str] = []
    for index, row in enumerate(rows):
        where = f"latest.json.sensors[{index}]"
        if not isinstance(row, dict):
            result.error(f"{where} is {C.js_kind(row)}, expected an object")
            continue
        sensor_id = row.get("id")
        if sensor_id not in published:
            result.error(f"{where}.id {sensor_id!r} is not in sensors.geojson")
            continue
        for key in ("staleness", "activity", "count"):
            if row.get(key) != published[sensor_id].get(key):
                result.error(
                    f"{where}.{key} is {row.get(key)!r} but sensors.geojson says "
                    f"{published[sensor_id].get(key)!r}"
                )
        if isinstance(row.get("lastObservation"), str):
            observed.append(row["lastObservation"])
    for label, value in (("latest.json.latestObservation", latest.get("latestObservation")),):
        if value is not None and not (isinstance(value, str) and value.endswith("Z")):
            result.error(f"{label} must be ISO-8601 UTC ending in Z, got {value!r}")
    newest = max((p["lastObservation"] for p in published.values() if p.get("lastObservation")), default=None)
    if newest and latest.get("latestObservation") != newest:
        result.error(
            f"latest.json.latestObservation {latest.get('latestObservation')!r} != the newest "
            f"lastObservation in sensors.geojson ({newest!r})"
        )
    digest = C.content_hash(features)
    if latest.get("contentHash") != digest:
        result.error(
            f"latest.json.contentHash {latest.get('contentHash')!r} != sha256 over sensors.geojson "
            f"{digest!r}"
        )


# --------------------------------------------------------------------------- raw cross-check


def _parse_published_utc(value: Any) -> datetime | None:
    """A published `observedAt`, which is ISO-8601 UTC with a Z suffix.

    NOT `parse_source_timestamp`. The published field is an INSTANT, so it
    carries `Z`; the source column is a civil WALL CLOCK. Reinterpreting
    `05:15Z` as 05:15 local would be four hours out in summer — and wrong
    quietly enough that the cross-check below would simply find no rows, print
    nothing, and pass.
    """
    if not isinstance(value, str):
        return None
    try:
        parsed = datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def check_against_raw(features: list[dict], count_rows: Iterable[dict], result: Result) -> None:
    """Recompute the published numbers from the raw snapshot. I3 and I4.

    Independent of the build on purpose: this recomputes what the geojson claims
    from the rows the city published, so a build that summed both twins, or the
    wrong twin, or summed before collapsing, fails here.
    """
    rows = list(count_rows)
    if not rows:
        result.warn("no raw count rows supplied; skipped the twin-collapse recomputation")
        return

    by_sensor: dict[str, dict[Any, int]] = {}
    directions: dict[str, set] = {}
    statuses: Tally = Tally()
    modes: Tally = Tally()
    granularities: Tally = Tally()
    for row in rows:
        sensor_id = C.normalise_text(row.get("sensor_id")) or ""
        moment = C.parse_source_timestamp(row.get("timestamp"))
        if moment is None:
            continue
        modes[C.normalise_text(row.get("travelmode")) or "<null>"] += 1
        statuses[C.normalise_text(row.get("status")) or "<null>"] += 1
        granularities[C.normalise_text(row.get("granularity")) or "<null>"] += 1
        direction = C.normalise_text(row.get("direction")) or "<null>"
        directions.setdefault(sensor_id, Tally())[direction] += 1
        value = C.parse_count(row.get("counts"))
        if value is not None:
            series = by_sensor.setdefault(sensor_id, {})
            series[moment] = series.get(moment, 0) + value

    for value, count in sorted(modes.items()):
        if value != "pedestrian":
            result.note_drift(
                f"{count} raw count row(s) with travelmode={value!r} in a pedestrian snapshot"
            )
    for value, count in sorted(statuses.items()):
        if value not in KNOWN_COUNT_STATUSES:
            result.note_drift(f"unknown count status {value!r} x{count}")
    for value, count in sorted(granularities.items()):
        if value not in C.GRANULARITIES:
            # The 15-minute bucket IS the baseline key, so a new interval is not
            # cosmetic: it would silently mix two sampling rates into one
            # distribution.
            result.note_drift(
                f"{count} raw count row(s) with granularity={value!r}; the baseline is keyed on "
                f"15-minute buckets, so a new interval changes every expected value"
            )
    for sensor_id, found in sorted(directions.items()):
        unexpected = sorted(set(found) - set(C.DIRECTIONS))
        if unexpected:
            result.note_drift(f"sensor_id {sensor_id!r} has direction(s) {unexpected}")

    checked = 0
    for index, feature in enumerate(features):
        where = f"feature[{index}]"
        properties = feature.get("properties") or {}
        source_ids = properties.get("sensorIds") or []
        observed_at = _parse_published_utc(properties.get("observedAt"))
        if not isinstance(source_ids, list) or not source_ids or observed_at is None:
            continue
        # observedAt is published in UTC as an instant; the rows are civil wall
        # clocks. Round-tripping through NYC_TZ is the ONLY correct conversion,
        # and it is the same one `parse_source_timestamp` applied in the other
        # direction — so the two agree by construction rather than by luck.
        observed_source = observed_at.astimezone(C.NYC_TZ)
        representative = min(source_ids)
        expected_from_raw = by_sensor.get(representative, {}).get(observed_source)
        if expected_from_raw is None:
            result.error(
                f"{where}.properties.observedAt {properties.get('observedAt')!r} has no rows in the "
                f"raw snapshot for sensor id {representative!r} ({to_source(observed_source)} source frame)"
            )
            continue
        checked += 1
        naive_total = sum(by_sensor.get(value, {}).get(observed_source, 0) for value in source_ids)

        if properties.get("count") != expected_from_raw:
            result.error(
                f"{where}.properties.count {properties.get('count')!r} != in+out over the raw "
                f"rows of the representative sensor id {representative!r} at observedAt "
                f"({expected_from_raw})"
            )
        # I4: the twins must be byte-identical AND the published total must be
        # the once-counted one, not the twin-doubled one. Note this is vacuous
        # at a zero reading — both sides are 0 — which is why the published
        # `count` is checked against a nonzero hour too by the build tests, and
        # why the deep cross-check is worth running at all.
        if naive_total != expected_from_raw * len(source_ids):
            result.error(
                f"{where} twin-collapse invariant failed: summing every published sensor id "
                f"({', '.join(source_ids)}) at observedAt gives {naive_total}, not "
                f"{expected_from_raw} x {len(source_ids)}; the twins are not identical"
            )
    if rows and not checked:
        result.warn(
            "no published feature had an observedAt that could be recomputed from the raw "
            "snapshot; the twin-collapse cross-check did not run"
        )


def to_source(moment: datetime) -> str:
    """An instant as the source's civil wall clock, for an error message."""
    return moment.astimezone(C.NYC_TZ).strftime("%Y-%m-%dT%H:%M:%S")


def check_sensor_identity(
    features: list[dict], sensor_rows: Iterable[dict], result: Result
) -> None:
    """Every published counter must trace back to a physical counter in 6up2-gnw8."""
    rows = list(sensor_rows)
    if not rows:
        result.warn("no raw sensor rows supplied; skipped the counter-identity cross-check")
        return
    resolved = C.resolve_counter_identity([row for row in rows if C.is_pedestrian_capable(row)])
    known_serials = {group["counterSerial"] for group in resolved}
    known_ids = {value for group in resolved for value in group["sensorIds"]}
    for index, feature in enumerate(features):
        properties = feature.get("properties") or {}
        serial = properties.get("counterSerial")
        if isinstance(serial, str) and serial not in known_serials:
            result.error(
                f"feature[{index}].counterSerial {serial!r} is not a counters_serial in "
                "6up2-gnw8, so this feature does not resolve to a physical counter"
            )
        for value in properties.get("sensorIds") or []:
            if value not in known_ids:
                result.error(
                    f"feature[{index}].sensorIds contains {value!r}, which no pedestrian counter "
                    "in 6up2-gnw8 claims"
                )


# --------------------------------------------------------------------------- entry point


def validate(
    *,
    geojson: Any = None,
    latest: Any = None,
    count_rows: Iterable[dict] | None = None,
    sensor_rows: Iterable[dict] | None = None,
    min_sensors: int = MIN_SENSORS,
    out_dir: Path | None = None,
    raw_sensors: Path | None = None,
    raw_counts: Path | None = None,
) -> Result:
    """Validate artifacts. Pass them in, or point at `out_dir` for a tmp run.

    Nothing here reads the repo unless asked: every argument defaults to None
    and the paths are only touched when a caller supplies them, so the tests can
    validate an inline dataset and CI can smoke-test a build in a tmp dir.
    """
    result = Result()
    if geojson is None or latest is None:
        base = out_dir or C.PUBLIC_DATA_DIR
        geojson_path = base / "sensors.geojson"
        latest_path = base / "latest.json"
        for path in (geojson_path, latest_path):
            if not path.exists():
                result.error(f"missing artifact: {path} — run scripts/walk/refresh.py")
        if result.errors:
            return result
        geojson = C.read_json_file(geojson_path)
        latest = C.read_json_file(latest_path)

    features = check_features(geojson, result)
    if features:
        check_latest(latest, features, result)
    if count_rows is not None:
        check_against_raw(features, count_rows, result)
    if sensor_rows is not None:
        check_sensor_identity(features, sensor_rows, result)
    if not features:
        # Never certify an empty dataset. Four counters is a small number, and a
        # fetch or a build that loses all of them looks exactly like a city
        # nobody measures.
        result.error(
            "sensors.geojson has no features; refusing to certify an empty dataset "
            "(4 physical counters measured 2026-09-28)"
        )
    elif len(features) < min_sensors:
        result.error(
            f"counter count collapse: {len(features)} counters published, expected at least "
            f"{min_sensors} (2026-09-28 measured 4 physical counters)"
        )
    return result


def validate_paths(
    *,
    out_dir: Path | None = None,
    raw_sensors: Path | None = None,
    raw_counts: Path | None = None,
    min_sensors: int = MIN_SENSORS,
) -> Result:
    """Read the artifacts and the raw snapshots, then validate.

    The raw cross-checks are skipped (with a warning) when the snapshots are
    absent, so a checkout with only published artifacts still validates.
    """
    base = out_dir or C.PUBLIC_DATA_DIR
    sensors_path = raw_sensors or C.SENSORS_RAW_PATH
    counts_path = raw_counts or C.COUNTS_RAW_PATH
    sensor_rows = C.load_raw_rows(sensors_path) if sensors_path.exists() else None
    count_rows = C.load_raw_rows(counts_path) if counts_path.exists() else None
    return validate(
        out_dir=base,
        count_rows=count_rows,
        sensor_rows=sensor_rows,
        min_sensors=min_sensors,
    )


def format_result(result: Result) -> str:
    stats = result.stats
    lines = ["WALK VALIDATION"]
    if stats:
        lines.append(
            f"  counters {stats.get('sensorCount')}   unique ids {stats.get('uniqueIds')}"
            f"   serials {stats.get('uniqueSerials')}"
            f"   source sensor ids {stats.get('uniqueSourceIds')}"
        )
        lines.append(
            "  activity   "
            + "  ".join(f"{key} {value}" for key, value in (stats.get("activity") or {}).items())
        )
        lines.append(
            "  staleness  "
            + "  ".join(f"{key} {value}" for key, value in (stats.get("staleness") or {}).items())
        )
        lines.append(f"  sensorIds per counter  {C.compact_json(stats.get('twinCount', {}))}")
    if result.warnings:
        lines.append(f"  {len(result.warnings)} warning(s)")
        for warning in result.warnings:
            lines.append(f"    ! {warning}")
    if result.errors:
        lines.append(f"  FAILED with {len(result.errors)} error(s)")
        for error in result.errors[:40]:
            lines.append(f"    x {error}")
        if len(result.errors) > 40:
            lines.append(f"    ... and {len(result.errors) - 40} more")
    else:
        lines.append("  ok — artifacts match the contract")
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--strict", action="store_true", help="treat drift warnings as failures (for CI)")
    parser.add_argument(
        "--min-sensors", type=int, default=MIN_SENSORS, help="fail below this counter count"
    )
    parser.add_argument("--out-dir", type=Path, default=None, help="read sensors.geojson/latest.json from here")
    parser.add_argument("--raw-sensors", type=Path, default=None, help="raw sensor snapshot for the cross-check")
    parser.add_argument("--raw-counts", type=Path, default=None, help="raw count snapshot for the cross-check")
    args = parser.parse_args(argv)

    try:
        result = validate_paths(
            out_dir=args.out_dir,
            raw_sensors=args.raw_sensors,
            raw_counts=args.raw_counts,
            min_sensors=args.min_sensors,
        )
    except C.PipelineError as exc:
        print(f"validate_walk: {exc}", file=sys.stderr)
        return 1

    print(format_result(result))
    if result.errors:
        return 1
    if args.strict and result.warnings:
        print(
            f"validate_walk: --strict and {len(result.warnings)} drift warning(s); see above",
            file=sys.stderr,
        )
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
