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
| v1.0.0-beta.3 | published 2026-09-06 | [1.0.0-beta.3.md](1.0.0-beta.3.md) |
| v1.0.0-beta.4 | published 2026-09-07 | [1.0.0-beta.4.md](1.0.0-beta.4.md) |
| v1.0.0-beta.5 | published 2026-09-08 | [1.0.0-beta.5.md](1.0.0-beta.5.md) |
| v1.0.0-beta.6 | published 2026-09-11 | [1.0.0-beta.6.md](1.0.0-beta.6.md) |
| v1.0.0-beta.7 | published 2026-09-11 | [1.0.0-beta.7.md](1.0.0-beta.7.md) |
| v1.0.0-beta.8 | published 2026-09-12 | [1.0.0-beta.8.md](1.0.0-beta.8.md) |
| v1.0.0-beta.9 | published 2026-09-13 | [1.0.0-beta.9.md](1.0.0-beta.9.md) |
| v1.0.0-beta.10 | published 2026-09-13 | [1.0.0-beta.10.md](1.0.0-beta.10.md) |
| v1.0.0-beta.11 | published 2026-09-13 | [1.0.0-beta.11.md](1.0.0-beta.11.md) |
| v1.0.0-beta.12 | published 2026-09-14 | [1.0.0-beta.12.md](1.0.0-beta.12.md) |
| v1.0.0-beta.13 | published 2026-09-16 | [1.0.0-beta.13.md](1.0.0-beta.13.md) |
| v1.0.0-beta.14 | published 2026-09-18 | [1.0.0-beta.14.md](1.0.0-beta.14.md) |
| v1.0.0-beta.15 | published 2026-09-19 | [1.0.0-beta.15.md](1.0.0-beta.15.md) |
| v1.0.0-beta.16 | queued | [1.0.0-beta.16.md](1.0.0-beta.16.md) |

How a version moves: work lands on `working`; a release folds `working` into
`main`, runs the local pool, then one hosted gate run; the verdict is recorded
in `scripts/gate/gate-ledger.jsonl`; the tag is cut on the release home
(github.com/Whq02/MercuryCLI) and the release workflow builds and publishes
the archives. Before the tag, `bun scripts/ops/check-typed-model-ids.ts` runs
in the release owner's own shell: it reads the signed-in credentials through
Mercury's own resolvers (never printing one), fetches every model list they
can reach and prints one line per typed model id — served, not served, or the
family's list unreachable — exiting non-zero on any typed id a fetched list
does not serve; it writes nothing under the config home. A family that
publishes no model list (Z.AI) is judged only with `--probe-by-completion`,
which sends one minimal completion per typed id — a few tokens billed each —
and is passed by hand, never by default; without it those ids read the dated
typed table.
