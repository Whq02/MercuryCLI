#!/usr/bin/env bash
# gate-class: cpu
# gate-watch: src/QueryEngine* src/boot/launchGraph* src/bootstrap/state* src/cli/headless/**
# gate-watch: src/cli/print* src/components/App* src/constants/betas* src/constants/oauth*
# gate-watch: src/entrypoints/agentSdkTypes* src/ink/** src/input-core/command-queue*
# gate-watch: src/input-core/pending-input* src/query/** src/replLauncher* src/screens/REPL*
# gate-watch: src/services/analytics/featureGates*
# gate-watch: src/services/providers/anthropic/** src/services/api/errors* src/services/api/withRetry*
# gate-watch: src/services/compact/autoCompact* src/services/tokenEstimation*
# gate-watch: src/state/AppStateStore* src/substrate/startupMenu* src/tools/AgentTool/constants*
# gate-watch: src/tools/BriefTool/prompt* src/tools/SyntheticOutputTool/SyntheticOutputTool*
# gate-watch: src/types/ids* src/types/textInputTypes* src/utils/**
# gate-watch: src/commands/caching/**
# ============================================================================
#  scripts/core-runtime/run-all.sh — contract suite. In-process provers only —
#  the perf receipt runner (bench-baseline.ts) is operator-run, not a member.
# ============================================================================
set -uo pipefail
cd "$(dirname "$0")/../.." || exit 1
BUN="${BUN:-$HOME/.bun/bin/bun}"
fail=0
# One wall-seconds line per prover — the pool engine reads exactly this shape.
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss\n' "$p" "$(( SECONDS - $2 ))"; }
# Every prover runs; one red fails the suite at the end (a red never hides
# the provers behind it).

echo "── core-runtime: writer contract (T1)"
__t=$SECONDS; "$BUN" run scripts/core-runtime/prove-writer-contract.ts || fail=1; prover_mark scripts/core-runtime/prove-writer-contract.ts "$__t"

echo "── core-runtime: alt-paint scroll safety (T1)"
__t=$SECONDS; "$BUN" run scripts/core-runtime/prove-alt-paint-scroll.ts || fail=1; prover_mark scripts/core-runtime/prove-alt-paint-scroll.ts "$__t"

echo "── core-runtime: screen contract (T2)"
__t=$SECONDS; "$BUN" run scripts/core-runtime/prove-screen-contract.ts || fail=1; prover_mark scripts/core-runtime/prove-screen-contract.ts "$__t"

echo "── core-runtime: compose contract (T3)"
__t=$SECONDS; "$BUN" run scripts/core-runtime/prove-compose-contract.ts || fail=1; prover_mark scripts/core-runtime/prove-compose-contract.ts "$__t"

echo "── core-runtime: input contract (T4)"
__t=$SECONDS; "$BUN" run scripts/core-runtime/prove-input-contract.ts || fail=1; prover_mark scripts/core-runtime/prove-input-contract.ts "$__t"

echo "── core-runtime: input/Unicode fidelity corpus (WAVE C1; HOLD-MAC: native receipts pending)"
__t=$SECONDS; "$BUN" run scripts/core-runtime/prove-input-unicode-corpus.ts || fail=1; prover_mark scripts/core-runtime/prove-input-unicode-corpus.ts "$__t"

echo "── core-runtime: session contract (T5)"
__t=$SECONDS; "$BUN" run scripts/core-runtime/prove-session-contract.ts || fail=1; prover_mark scripts/core-runtime/prove-session-contract.ts "$__t"

echo "── core-runtime: root contract (T6)"
__t=$SECONDS; "$BUN" run scripts/core-runtime/prove-root-contract.ts || fail=1; prover_mark scripts/core-runtime/prove-root-contract.ts "$__t"

echo "── core-runtime: geometry contract (T7)"
__t=$SECONDS; "$BUN" run scripts/core-runtime/prove-geometry-contract.ts || fail=1; prover_mark scripts/core-runtime/prove-geometry-contract.ts "$__t"

echo "── core-runtime: runloop contract (T8)"
__t=$SECONDS; "$BUN" run scripts/core-runtime/prove-runloop-contract.ts || fail=1; prover_mark scripts/core-runtime/prove-runloop-contract.ts "$__t"

echo "── core-runtime: runsurface contract (T10-T12)"
__t=$SECONDS; "$BUN" run scripts/core-runtime/prove-runsurface-contract.ts || fail=1; prover_mark scripts/core-runtime/prove-runsurface-contract.ts "$__t"

echo "── core-runtime: input-scheduling contract (T13/T14)"
__t=$SECONDS; "$BUN" run scripts/core-runtime/prove-inputsched-contract.ts || fail=1; prover_mark scripts/core-runtime/prove-inputsched-contract.ts "$__t"

echo "── core-runtime: delivery exactly-once (steer-removal)"
__t=$SECONDS; "$BUN" run scripts/core-runtime/prove-delivery-exactly-once.ts || fail=1; prover_mark scripts/core-runtime/prove-delivery-exactly-once.ts "$__t"

echo "── core-runtime: driver settle race (delivery-verifier)"
__t=$SECONDS; "$BUN" run scripts/core-runtime/prove-driver-settle-race.ts || fail=1; prover_mark scripts/core-runtime/prove-driver-settle-race.ts "$__t"

echo "── core-runtime: delivery interleavings (delivery-verifier)"
__t=$SECONDS; "$BUN" run scripts/core-runtime/prove-delivery-interleavings.ts || fail=1; prover_mark scripts/core-runtime/prove-delivery-interleavings.ts "$__t"
__t=$SECONDS; "$BUN" run scripts/core-runtime/prove-field-findings-input-family.ts || fail=1; prover_mark scripts/core-runtime/prove-field-findings-input-family.ts "$__t"

echo "── core-runtime: boot contract (T15)"
__t=$SECONDS; "$BUN" run scripts/core-runtime/prove-boot-contract.ts || fail=1; prover_mark scripts/core-runtime/prove-boot-contract.ts "$__t"

echo "── core-runtime: boot-env attribution (a saved default is never a real env pin)"
__t=$SECONDS; "$BUN" run scripts/core-runtime/prove-bootenv-attribution.ts || fail=1; prover_mark scripts/core-runtime/prove-bootenv-attribution.ts "$__t"

__t=$SECONDS; "$BUN" run scripts/core-runtime/prove-face-birth-ground.ts || fail=1; prover_mark scripts/core-runtime/prove-face-birth-ground.ts "$__t"

echo "── core-runtime: provider contract (T16)"
__t=$SECONDS; "$BUN" run scripts/core-runtime/prove-provider-contract.ts || fail=1; prover_mark scripts/core-runtime/prove-provider-contract.ts "$__t"

echo "── core-runtime: request-shape goldens (T16 completion)"
__t=$SECONDS; "$BUN" run scripts/core-runtime/prove-request-shape.ts || fail=1; prover_mark scripts/core-runtime/prove-request-shape.ts "$__t"

echo "── core-runtime: display-ANSI parser contract (T20)"
__t=$SECONDS; "$BUN" run scripts/core-runtime/prove-ansi-parser-contract.ts || fail=1; prover_mark scripts/core-runtime/prove-ansi-parser-contract.ts "$__t"

echo "── core-runtime: message-model contract (T18)"
__t=$SECONDS; "$BUN" run scripts/core-runtime/prove-message-model-contract.ts || fail=1; prover_mark scripts/core-runtime/prove-message-model-contract.ts "$__t"

echo "── core-runtime: state contract (T17)"
__t=$SECONDS; "$BUN" run scripts/core-runtime/prove-state-contract.ts || fail=1; prover_mark scripts/core-runtime/prove-state-contract.ts "$__t"

echo "── core-runtime: boot/MCP independence"
__t=$SECONDS; "$BUN" run scripts/core-runtime/prove-boot-mcp-independence.ts || fail=1; prover_mark scripts/core-runtime/prove-boot-mcp-independence.ts "$__t"

echo "── core-runtime: attribution spelling contract (lane RQ)"
__t=$SECONDS; "$BUN" run scripts/core-runtime/prove-attribution-spellings.ts || fail=1; prover_mark scripts/core-runtime/prove-attribution-spellings.ts "$__t"

echo "── core-runtime: the ledger on every exit (FN-018 ranks 1 + 5 + 11)"
__t=$SECONDS; "$BUN" run scripts/core-runtime/prove-ledger-every-exit.ts || fail=1; prover_mark scripts/core-runtime/prove-ledger-every-exit.ts "$__t"

echo "── core-runtime: the fork's usage fold (FN-018 rank 8)"
__t=$SECONDS; "$BUN" run scripts/core-runtime/prove-fork-usage-fold.ts || fail=1; prover_mark scripts/core-runtime/prove-fork-usage-fold.ts "$__t"

echo "── core-runtime: the metering S3 rows (FN-018 ranks 16-23)"
__t=$SECONDS; "$BUN" run scripts/core-runtime/prove-metering-s3-truth.ts || fail=1; prover_mark scripts/core-runtime/prove-metering-s3-truth.ts "$__t"
__t=$SECONDS; "$BUN" run scripts/core-runtime/prove-resize-hold-cursor.ts || fail=1; prover_mark scripts/core-runtime/prove-resize-hold-cursor.ts "$__t"

if [ "$fail" = "0" ]; then echo "core-runtime suite: green"; else echo "core-runtime suite: RED"; fi
exit "$fail"
