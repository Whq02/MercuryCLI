# Releases — one page per tag

One file per release tag, kept up to date from the moment a version is queued
until the tag after it ships. Each page carries the same four parts:

1. **State** — queued · tagged · published · superseded, with dates.
2. **Verdict** — the hosted gate run and the gate-ledger row the tag stands on.
3. **What shipped** — the user-facing notes (the bundled changelog is the one
   source; this page points at it and adds what a reader of the tree wants).
4. **Known gaps and the queue** — what this version does not do, and what is
   lined up for the next one, each item with its reason.

| tag | state | page |
| --- | --- | --- |
| v1.0.0-beta.1 | tagged, never published | [1.0.0-beta.1.md](1.0.0-beta.1.md) |
| v1.0.0-beta.2 | published 2026-09-04 | [1.0.0-beta.2.md](1.0.0-beta.2.md) |
| v1.0.0-beta.3 | queued | [1.0.0-beta.3.md](1.0.0-beta.3.md) |

How a version moves: work lands on `working`; a release folds `working` into
`main`, runs the local pool, then one hosted gate run; the verdict is recorded
in `scripts/gate/gate-ledger.jsonl`; the tag is cut on the release home
(github.com/Whq02/MercuryCLI) and the release workflow builds and publishes
the archives.
