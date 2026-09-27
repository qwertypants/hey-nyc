# 0004. Record decisions as ADRs, recalled from an index

**Status:** Accepted
**Date:** 2026-09-27

## Context

By 2026-09-27 this project had real, load-bearing decisions and no place to
record them. The reasoning existed, but it was scattered and mixed in with
operational instructions across five documents:

| Document | What it actually contained |
| --- | --- |
| `docs/contributing.md` | A rule, and the *reason* the rule exists |
| `docs/data-pipeline.md` | A runbook, and four decisions with rejected alternatives |
| `docs/basemap.md` | A decision, and a comparison table with the option that lost |
| `docs/data-licensing.md` | A constraint that overrides the licence file |
| `README.md` | The same decisions, summarised for readers |

Three things follow from that, and all three cost real time:

1. **A decision is unfindable.** "Why is there no geocoder autocomplete?" is
   answerable — it is in `basemap.md`, under *Geocoding*, on line 86 of 92. But
   you have to know which file to open. A contributor or an agent working from a
   cold start has no index and no way to know one exists.
2. **A decision is invisible from the code.** `src/types/location.ts` opens with
   a comment saying `FROZEN CONTRACT`. It does not say *why* the two languages
   must move together, what was tried instead, or that `content_hash()` is more
   dangerous than it looks. Those are the three things you need at the moment you
   are about to break it.
3. **A ban has no stated basis, so it gets relaxed by accident.** "No AI
   features" reads like a preference. It is actually a hard consequence of the
   core promise — the source has no such fields, so any such feature is
   invented data. An agent or a well-meaning contributor who does not know that
   will treat the ban as negotiable, which is exactly how a project loses its
   defining constraint by increments.

The existing documents are good and were not the problem. The problem is that
they are *operational*: they answer "how do I run this" and "what are the
rules", and they only incidentally answer "why is it like this".

## Decision

Add a small, explicit decision record, and point every entry point at it.

- **`docs/adr/NNNN-kebab-title.md`** — one file per decision. Numbered, dated,
  immutable header.
- **`docs/decisions.md`** — the index. One table, the trigger list, the
  template. This is what you read first.
- **`AGENTS.md`** — the operating contract for an agent: read this, read the
  index, recall before deciding.
- **Bidirectional links.** An ADR links the files it governs; the code links the
  ADR. `src/types/location.ts` now says `see docs/adr/0001`.
- **A short trigger list.** A named set of changes that require a new ADR.
  Deliberately short — see the consequences.

**Docs only. No CI gate, no pre-commit hook, no new job.** Enforcement is by
convention, reinforced by one question in the pull-request template.

**ADRs are never deleted.** Changing a decision means writing a new ADR that
supersedes the old one and flipping the old header to `Superseded by NNNN`.

**An ADR without alternatives is not finished.** The alternatives section must
name what was rejected and, where there was one, the measurement that rejected
it. That is this repository's existing habit — three tables in
`data-pipeline.md` already do it — and it is the part with the actual value. A
decision record that only records the decision is a comment.

## Alternatives considered

### A `CHANGELOG.md`

- Pros: conventional, and it records what shipped.
- Rejected: it answers "what changed in 1.4" and cannot answer "am I allowed to
  do this". Neither can it record a decision that *rejected* something, which is
  the half that stops the same argument being had twice. Nothing was shipped on
  2026-09-27 that needed one.

### A machine-readable `docs/decisions/index.json`

- Pros: an agent or a script can query "show me the accepted decisions touching
  the pipeline" without parsing prose.
- Rejected: nothing queries it. It would be a second hand-maintained copy of the
  index table that drifts from the Markdown, and it would be maintained by
  hand. If a tool ever needs this, that tool's existence is the reason, and it
  arrives with its own ADR.

### A CI gate that fails a contract change with no ADR

- Pros: real enforcement. Nobody can quietly ship a fourth runtime dependency.
- Rejected: this repository uses CI to verify things and convention to decide
  things — `ci.yml` runs exactly two jobs by design, and the data workflow's
  gates are about artefacts, not about intent. A lint-style check that fires on
  *intent* is a different kind of tool, and a check that is wrong is worse than
  a convention that is merely ignored: it trains people to bypass it. This is
  reversible — see the last consequence.

### Comments and docstrings only

- Rejected: they drift from the file they sit in the moment the file is edited,
  and they cannot be superseded. There is nowhere to record that the previous
  reasoning was wrong, which is the one case where the history matters most.

### Collapse the existing docs into the ADRs so reasoning lives in one place

- Rejected: a much larger diff touching five documents and every link into them,
  for a benefit nobody asked for. `data-pipeline.md` is a runbook — it is
  correct to be long, and its content is operational rather than decisional. The
  ADRs cite those documents as their evidence rather than replacing them.

### One README section instead of a separate index

- Rejected: the README is for people deciding whether to use the site. Decision
  recall is for people about to change the code. Mixing them buries the triggers
  under the dataset description.

## Consequences

- **The trigger list is short on purpose.** It covers: runtime or pipeline
  dependencies, the frozen contract, `contentHash` and the id recipe, a second
  feature kind in `cafes.geojson`, the basemap, geocoding or the data source, and
  any relaxation of a "what not to add" rule. Everything else is an issue or an
  ordinary pull request. A trigger list nobody can hold in their head is the same
  as no trigger list, and this one is a judgement call that a future ADR may
  reasonably reverse.
- **The system can go stale, which is a real cost.** An index with no owner
  rots. The pull-request question is the mitigation, and it is the weakest link —
  it depends on a human ticking a box honestly.
- **Enforcement can be added later, cheaply, and deliberately.** A
  `scripts/check_decisions.py` that validates numbering, format and
  supersession links is a self-contained change. If the convention is being
  ignored after a few months, that is the moment to add it, and it arrives as a
  new ADR that supersedes this one rather than an edit to it.
- **The retroactive ADRs are labelled.** 0001–0003 are marked
  `Accepted (retroactive)` and name the commit they were reconstructed from, so
  nobody reads them as contemporaneous notes. They record decisions that were
  made and reasoned at the time and written down later — which is honest, and
  better than backdating them.
- **This document set is now itself a thing that can contradict the code.** If
  `AGENTS.md` and `docs/contributing.md` disagree, `contributing.md` is the
  human contract and this is the summary. The ADR set points at it rather than
  restating it, so there is one place to be right.
