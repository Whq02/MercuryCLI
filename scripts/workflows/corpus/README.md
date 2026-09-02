# Router-party replay corpus (bench-corpus-v1)

Replayable, self-contained, MECHANICALLY-CHECKED task specs for the replay
benchmarks (`scripts/workflows/bench-replay.ts`, whose utilities also carry
`bench-workflow-routing.ts`; the P2 router-party benchmark itself retired with
the multiplayer estate). Each spec runs in its OWN local clone
pinned to the `baseRef` tag's commit (origin/main ref-pinned inside the clone so
executor lanes base on it; node_modules + dist clonefile-copied so suites run), and
success is judged FROM OUTSIDE by `successChecks` (command exit codes + file greps)
— no LLM judge, no self-report. Every task carries at least one check that FAILS
on the pristine base tree (a do-nothing arm can never score a pass — the
a preflight pinned this for all 8).

The corpus is distilled from this repo's real work classes (flag registration,
proof suites, seat-slot parsing, doc de-stale, small util + regression guard).

Timebox (corpus v3, operator-ratified): 20m per task, BOTH
arms symmetrically. The original flat 15m encoded an accidental anti-team bias:
solo never approaches either box (observed max ~10.5m across four full runs),
while the routed arm's only post-plumbing losses were missions that were ALIVE,
healthy, and mid-completion when the timer rang — an escalate round-trip (a
legitimate ambiguity-resolution meeting) adds ~3-5m on the heaviest tasks
(flag-registry-row: 538s clean → 932s+ with one escalate). 20m prices in ONE
such round-trip; the acceptance criterion itself (routed batch wall ≤ solo at
equal-or-lower error) is UNCHANGED. Check regex v2: 05's literal
token check gained case-insensitive semantic tolerance after the tank→executor
re-specification hop reproducibly paraphrased a semantically complete artifact.
Operator ratifies via `bench-replay.ts --dry-run` before the first billed run.
The acceptance criterion: routed batch wall-clock ≤ solo at
equal-or-lower error rate — `prove-party-flip.ts` refuses a default-ON party
flag without a committed green `verdict.json` whose corpusSha256 matches.
