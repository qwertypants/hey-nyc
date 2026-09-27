# 0002. Hash the features, never the timestamp

**Status:** Accepted (retroactive)
**Date:** 2026-09-27

Retroactive. Reconstructed from the initial commit `9c18edd` and the reasoning
that shipped in
[`docs/data-pipeline.md`](../data-pipeline.md#the-contenthash-and-why-it-exists).

## Context

`refresh-data.yml` runs daily at 10:23 UTC and commits the artifacts when the
data actually changed. If it commits when nothing changed, the repository gets a
no-op commit every single day, forever.

Each commit to `main` invalidates the npm cache, re-runs the build and triggers a
deploy. Three hundred and sixty-five of those a year is a self-inflicted outage
of the Pages build, not a maintenance cost.

The obvious way to detect the change is `git diff --quiet -- public/data`. It
does not work, and this is the single easiest thing to get wrong in this
pipeline. `retrievedAt` in `metadata.json` and `generatedAt` in `report.json`
are stamped with the current time on every run, so two of the three artifacts
always differ.

Measured by running `refresh_data.py --skip-fetch` twice, one minute apart:

| File | Result |
| --- | --- |
| `public/data/cafes.geojson` | byte-identical |
| `public/data/metadata.json` | differs — only `retrievedAt` |
| `data/processed/report.json` | differs — only `generatedAt` |
| `contentHash` | identical |

A naive diff therefore reports a change 365 days a year.

## Decision

Compute a `contentHash` over the **published features only**, and use it as the
primary change signal:

```
contentHash = sha256( canonical_json( features sorted by id ) )
```

`canonical_json` is `sort_keys=True`, `separators=(",", ":")`,
`ensure_ascii=False`.

The structural property that makes this work: **`metadata.json` and
`report.json` are not inputs to the hash.** The hash cannot observe a timestamp,
not because the code filters one out, but because no timestamp is in scope. There
is nothing to forget to exclude when someone adds a field later.

The digest is written into both `metadata.json` and `report.json`, and
`validate_data.py` recomputes it over `cafes.geojson` and asserts all three
agree. A hand-edited `cafes.geojson` cannot slip past.

**Two independent signals, and they must agree.** The workflow also compares all
three artifacts after treating `retrievedAt`, `generatedAt` and `sourceUpdatedAt`
as non-material. If both say changed, commit; if both say unchanged, restore and
stop; if they **disagree, fail without committing**. Disagreement means this
repository is broken, not that upstream drifted, and that is not a state to
resolve automatically.

`sourceUpdatedAt` is non-material on purpose. It is the dataset's
`rowsUpdatedAt`, which moves when DOT republishes metadata even if not one row
changed.

## Alternatives considered

### `git diff --quiet` on the artifacts

- Rejected by the measurement above. 365 no-op commits a year, each one
  invalidating the npm cache, rebuilding and redeploying.

### Hash `metadata.json` in full

- Pros: trivially simple, one file.
- Rejected: `retrievedAt` is a field in it. The same failure as the diff, with
  extra machinery.

### Hash a timestamp-stripped copy of everything

- Pros: catches changes in any artifact.
- Rejected: "strip the timestamps" is a rule someone has to remember. The
  features-only hash achieves the same result by construction, which is strictly
  more robust. Stripping also invites someone to add a new timestamped field
  later and forget to add it to the strip list.

### Hash the set of ids

- Pros: cheap, and a row appearing or disappearing is the change that matters
  most.
- Rejected: it cannot see a corrected name or a moved coordinate, which is
  precisely the change a user would notice on the map. The hash has to cover the
  published values, not just the keys.

### Trust one signal

- Rejected: the whole point of the second signal is disagreement detection. A
  single signal that reads `true` on unchanged data is indistinguishable from a
  genuinely new café until someone notices by hand. Two signals that disagree
  loudly on a broken repository is the failure mode worth paying for.

### `git update-index --assume-unchanged` on the two timestamped files

- Rejected: it does not survive a fresh clone, it is invisible to anyone reading
  the history, and it leaves the commit with a half-written artifact set that
  the hash still has to catch. It hides the symptom and keeps the disease.

## Consequences

- **Never change `content_hash()` casually.** A change to the definition makes
  every refresh look like a data change, forever, for the same reason the naive
  diff does. If it moves, that is a deliberate contract change — see
  [ADR 0001](0001-freeze-the-location-schema.md).
- A new NYC Open Data layer gets **its own** hash and its own comparison. Never
  widen this one to cover a second artifact: a layer that never changes would
  then make the whole commit gate look quiet forever, and the next real change
  would be invisible.
- The id recipe feeds the hash, so the ids being deterministic and
  order-independent is not a nicety — it is what makes the no-op check work. See
  [`data-pipeline.md`](../data-pipeline.md#the-stable-id) for the candidate
  table that rejected `bbl`, `bin` and friends.
- `--strict` turns every recorded merge anomaly into a CI failure, so a hash
  that legitimately moves is always accompanied by a human having looked at why.
