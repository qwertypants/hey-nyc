# 0001. Freeze the location schema

**Status:** Accepted (retroactive)
**Date:** 2026-09-27

Retroactive. Reconstructed from the initial commit `9c18edd` and the reasoning
that shipped in [`docs/contributing.md`](../contributing.md#the-frozen-contract).
It was made on the first day and written down later; nothing about the decision
changed in between.

## Context

The published dataset has a schema, and that schema is written down **twice**:

```
scripts/_common.py  PROPERTY_ORDER, PROPERTY_TYPES, ID_RE, DINING_TYPES, BOROUGHS
        |  writes
        v
public/data/cafes.geojson  +  metadata.json  +  report.json
        |  asserted by
        v
scripts/validate_data.py  <->  src/types/location.ts
        |  asserted by
        v
src/data/dataset.ts  validateCollection() / validateMetadata()  (browser)
```

One implementation is Python and writes the artifacts. The other is TypeScript
and consumes them. **Nothing at runtime ties them together.** The two can agree
perfectly for months and then disagree in a single commit, and the failure is not
a crash — it is a field that is silently `undefined` in the browser, or a
pipeline that stops matching the data it publishes.

The one mechanical guard is `validate_data.py --strict`, which asserts the
committed artifacts against a hand-maintained `SCHEMA`. That catches a
hand-edited `cafes.geojson` and upstream drift. It does **not** catch the more
likely event: someone renames a field in `src/types/location.ts`, everything
still validates, and 2 000 features quietly lose a property in the UI.

## Decision

**`src/types/location.ts` and the Python pipeline are two implementations of one
contract, and they are not allowed to disagree.** If you change a field name, a
field type, the set of allowed values, the property order, or the id recipe, you
change both sides in the same pull request.

Two tiers, because they are not equally expensive:

- **Additive** — a new optional or nullable property the UI does not depend on.
  Cheap. Do it.
- **Contract change** — renaming, retyping, removing, or changing the *meaning*
  of an existing property. Needs both sides, tests on both sides, the data
  dictionary, and a conversation in the pull request.

The minimum surface of a contract change is six files:

| File | Why |
| --- | --- |
| `src/types/location.ts` | The interface. The human-readable contract. |
| `scripts/_common.py` | `PROPERTY_ORDER` and `PROPERTY_TYPES`. `clean_data.py` asserts the emitted key order against `PROPERTY_ORDER` and fails loudly if you forget. |
| `scripts/clean_data.py` | Builds `properties`. The dict literal must be in `PROPERTY_ORDER`. |
| `scripts/validate_data.py` | `SCHEMA` and the checks in `check_geojson`. |
| `docs/data-dictionary.md` | The published schema section. |
| Tests on both sides | `tests/data-load.test.ts` and `tests/python/test_geojson.py`. |

The duplication between the two languages is **deliberate and is the price of
the contract**, not an oversight to be tidied away.

## Alternatives considered

### A single source of truth in JSON Schema, validated by both sides

One `schema.json`, consumed by `validate_data.py` and by a TypeScript validator.

- Pros: genuinely one definition; drift becomes structurally impossible.
- Rejected: the browser side needs to validate at runtime, which means shipping
  a validator — a fourth runtime dependency, and the one number this project
  spent its first day keeping at three. A codegen step was the other way in,
  and codegen puts a build step between a contributor and their first commit.

### Generate `src/types/location.ts` from the Python

- Pros: one side to edit.
- Rejected: the TypeScript interface is the *readable* artefact. It is what a
  contributor opens to learn the shape of the data. Generated, it becomes output
  nobody reads, and the human-readable contract — the actual product of this
  decision — is the thing that gets lost.

### Rely on `validate_data.py --strict` alone

- Pros: zero process, already in CI.
- Rejected: it validates the artifacts against `SCHEMA`, and `SCHEMA` is itself
  hand-maintained. If both `SCHEMA` and `location.ts` change and only one side
  of the pipeline follows, validation passes. It is a real guard and it is not
  sufficient; the written rule is what closes the gap.

### Trust the pull-request reviewer

- Pros: no new artefacts.
- Rejected: the pull-request template already asks whether the contract was
  touched, and it works most of the time. "Most of the time" is the problem —
  the question is invisible on a diff that renames one field in a file called
  `location.ts`, which is exactly the diff where it matters.

## Consequences

- A schema change is a six-file change. That is the cost, and it is paid
  deliberately.
- `PROPERTY_ORDER` is load-bearing in two places, so a forgotten key order
  fails loudly rather than publishing a differently-ordered artifact.
- The contract has its own index in [`decisions.md`](../decisions.md) and its
  own ADR, which is this one.
- Anything that adds a second feature kind to `cafes.geojson` is a contract
  change too — the filename is part of the contract. See
  [`data-pipeline.md`](../data-pipeline.md#adding-a-new-nyc-open-data-layer).
- `contentHash` is a separate and especially expensive thing to touch, because
  changing it makes every refresh look like a data change. That is
  [ADR 0002](0002-hash-features-never-the-timestamp.md).
