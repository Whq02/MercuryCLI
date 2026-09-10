#!/usr/bin/env bash
# gate-class: cpu
# gate-watch: src/QueryEngine* src/boot/launchGraph* src/bootstrap/state* src/cli/headless/**
# gate-watch: src/cli/print* src/components/App* src/constants/betas* src/constants/oauth*
# gate-watch: src/entrypoints/agentSdkTypes* src/ink/** src/input-core/command-queue*
# gate-watch: src/input-core/pending-input* src/query/** src/replLauncher* src/screens/REPL*
# gate-watch: src/services/providers/anthropic/** src/services/api/errors* src/services/api/withRetry*
# gate-watch: src/services/compact/autoCompact* src/services/tokenEstimation*
# gate-watch: src/state/AppStateStore* src/substrate/startupMenu* src/tools/AgentTool/constants*
# gate-watch: src/tools/BriefTool/prompt* src/tools/SyntheticOutputTool/SyntheticOutputTool*
# gate-watch: src/types/ids* src/types/textInputTypes* src/utils/**
# gate-watch: src/commands/caching/**
# gate-watch: src/render-engine/door.ts src/render-engine/cockpit/terminalOut.ts
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
cd "$(dirname "$0")/../.." || exit 1
BUN="${BUN:-$HOME/.bun/bin/bun}"
fail=0
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss rc=%s\n' "$p" "$(( SECONDS - $2 ))" "${3:?proof exit code required}"; }

echo "── core-runtime: writer contract (T1)"
__t=$SECONDS; __rc=0; "$BUN" run scripts/core-runtime/prove-writer-contract.ts || { __rc=$?; fail=1; }; prover_mark scripts/core-runtime/prove-writer-contract.ts "$__t" "$__rc"

echo "── core-runtime: alt-paint scroll safety (T1)"
__t=$SECONDS; __rc=0; "$BUN" run scripts/core-runtime/prove-alt-paint-scroll.ts || { __rc=$?; fail=1; }; prover_mark scripts/core-runtime/prove-alt-paint-scroll.ts "$__t" "$__rc"

echo "── core-runtime: screen contract (T2)"
__t=$SECONDS; __rc=0; "$BUN" run scripts/core-runtime/prove-screen-contract.ts || { __rc=$?; fail=1; }; prover_mark scripts/core-runtime/prove-screen-contract.ts "$__t" "$__rc"

echo "── core-runtime: compose contract (T3)"
__t=$SECONDS; __rc=0; "$BUN" run scripts/core-runtime/prove-compose-contract.ts || { __rc=$?; fail=1; }; prover_mark scripts/core-runtime/prove-compose-contract.ts "$__t" "$__rc"

echo "── core-runtime: input contract (T4)"
__t=$SECONDS; __rc=0; "$BUN" run scripts/core-runtime/prove-input-contract.ts || { __rc=$?; fail=1; }; prover_mark scripts/core-runtime/prove-input-contract.ts "$__t" "$__rc"

echo "── core-runtime: input/Unicode fidelity corpus (WAVE C1; HOLD-MAC: native receipts pending)"
__t=$SECONDS; __rc=0; "$BUN" run scripts/core-runtime/prove-input-unicode-corpus.ts || { __rc=$?; fail=1; }; prover_mark scripts/core-runtime/prove-input-unicode-corpus.ts "$__t" "$__rc"

echo "── core-runtime: session contract (T5)"
__t=$SECONDS; __rc=0; "$BUN" run scripts/core-runtime/prove-session-contract.ts || { __rc=$?; fail=1; }; prover_mark scripts/core-runtime/prove-session-contract.ts "$__t" "$__rc"

echo "── core-runtime: root contract (T6)"
__t=$SECONDS; __rc=0; "$BUN" run scripts/core-runtime/prove-root-contract.ts || { __rc=$?; fail=1; }; prover_mark scripts/core-runtime/prove-root-contract.ts "$__t" "$__rc"

echo "── core-runtime: geometry contract (T7)"
__t=$SECONDS; __rc=0; "$BUN" run scripts/core-runtime/prove-geometry-contract.ts || { __rc=$?; fail=1; }; prover_mark scripts/core-runtime/prove-geometry-contract.ts "$__t" "$__rc"

echo "── core-runtime: runloop contract (T8)"
__t=$SECONDS; __rc=0; "$BUN" run scripts/core-runtime/prove-runloop-contract.ts || { __rc=$?; fail=1; }; prover_mark scripts/core-runtime/prove-runloop-contract.ts "$__t" "$__rc"

echo "── core-runtime: runsurface contract (T10-T12)"
__t=$SECONDS; __rc=0; "$BUN" run scripts/core-runtime/prove-runsurface-contract.ts || { __rc=$?; fail=1; }; prover_mark scripts/core-runtime/prove-runsurface-contract.ts "$__t" "$__rc"

echo "── core-runtime: input-scheduling contract (T13/T14)"
__t=$SECONDS; __rc=0; "$BUN" run scripts/core-runtime/prove-inputsched-contract.ts || { __rc=$?; fail=1; }; prover_mark scripts/core-runtime/prove-inputsched-contract.ts "$__t" "$__rc"

echo "── core-runtime: the queue's recall pop (by identity)"
__t=$SECONDS; __rc=0; "$BUN" run scripts/core-runtime/prove-queue-pop.ts || { __rc=$?; fail=1; }; prover_mark scripts/core-runtime/prove-queue-pop.ts "$__t" "$__rc"

echo "── core-runtime: delivery exactly-once (steer-removal)"
__t=$SECONDS; __rc=0; "$BUN" run scripts/core-runtime/prove-delivery-exactly-once.ts || { __rc=$?; fail=1; }; prover_mark scripts/core-runtime/prove-delivery-exactly-once.ts "$__t" "$__rc"

echo "── core-runtime: driver settle race (delivery-verifier)"
__t=$SECONDS; __rc=0; "$BUN" run scripts/core-runtime/prove-driver-settle-race.ts || { __rc=$?; fail=1; }; prover_mark scripts/core-runtime/prove-driver-settle-race.ts "$__t" "$__rc"

echo "── core-runtime: delivery interleavings (delivery-verifier)"
__t=$SECONDS; __rc=0; "$BUN" run scripts/core-runtime/prove-delivery-interleavings.ts || { __rc=$?; fail=1; }; prover_mark scripts/core-runtime/prove-delivery-interleavings.ts "$__t" "$__rc"
__t=$SECONDS; __rc=0; "$BUN" run scripts/core-runtime/prove-field-findings-input-family.ts || { __rc=$?; fail=1; }; prover_mark scripts/core-runtime/prove-field-findings-input-family.ts "$__t" "$__rc"

echo "── core-runtime: boot contract (T15)"
__t=$SECONDS; __rc=0; "$BUN" run scripts/core-runtime/prove-boot-contract.ts || { __rc=$?; fail=1; }; prover_mark scripts/core-runtime/prove-boot-contract.ts "$__t" "$__rc"

echo "── core-runtime: boot-env attribution (a saved default is never a real env pin)"
__t=$SECONDS; __rc=0; "$BUN" run scripts/core-runtime/prove-bootenv-attribution.ts || { __rc=$?; fail=1; }; prover_mark scripts/core-runtime/prove-bootenv-attribution.ts "$__t" "$__rc"

__t=$SECONDS; __rc=0; "$BUN" run scripts/core-runtime/prove-face-birth-ground.ts || { __rc=$?; fail=1; }; prover_mark scripts/core-runtime/prove-face-birth-ground.ts "$__t" "$__rc"

echo "── core-runtime: provider contract (T16)"
__t=$SECONDS; __rc=0; "$BUN" run scripts/core-runtime/prove-provider-contract.ts || { __rc=$?; fail=1; }; prover_mark scripts/core-runtime/prove-provider-contract.ts "$__t" "$__rc"

echo "── core-runtime: request-shape goldens (T16 completion)"
__t=$SECONDS; __rc=0; "$BUN" run scripts/core-runtime/prove-request-shape.ts || { __rc=$?; fail=1; }; prover_mark scripts/core-runtime/prove-request-shape.ts "$__t" "$__rc"

echo "── core-runtime: display-ANSI parser contract (T20)"
__t=$SECONDS; __rc=0; "$BUN" run scripts/core-runtime/prove-ansi-parser-contract.ts || { __rc=$?; fail=1; }; prover_mark scripts/core-runtime/prove-ansi-parser-contract.ts "$__t" "$__rc"

echo "── core-runtime: message-model contract (T18)"
__t=$SECONDS; __rc=0; "$BUN" run scripts/core-runtime/prove-message-model-contract.ts || { __rc=$?; fail=1; }; prover_mark scripts/core-runtime/prove-message-model-contract.ts "$__t" "$__rc"

echo "── core-runtime: state contract (T17)"
__t=$SECONDS; __rc=0; "$BUN" run scripts/core-runtime/prove-state-contract.ts || { __rc=$?; fail=1; }; prover_mark scripts/core-runtime/prove-state-contract.ts "$__t" "$__rc"

echo "── core-runtime: boot/MCP independence"

echo "── core-runtime: attribution spelling contract (lane RQ)"
__t=$SECONDS; __rc=0; "$BUN" run scripts/core-runtime/prove-attribution-spellings.ts || { __rc=$?; fail=1; }; prover_mark scripts/core-runtime/prove-attribution-spellings.ts "$__t" "$__rc"

echo "── core-runtime: the ledger on every exit (FN-018 ranks 1 + 5 + 11)"
__t=$SECONDS; __rc=0; "$BUN" run scripts/core-runtime/prove-ledger-every-exit.ts || { __rc=$?; fail=1; }; prover_mark scripts/core-runtime/prove-ledger-every-exit.ts "$__t" "$__rc"

echo "── core-runtime: the fork's usage fold (FN-018 rank 8)"
__t=$SECONDS; __rc=0; "$BUN" run scripts/core-runtime/prove-fork-usage-fold.ts || { __rc=$?; fail=1; }; prover_mark scripts/core-runtime/prove-fork-usage-fold.ts "$__t" "$__rc"

echo "── core-runtime: the metering S3 rows (FN-018 ranks 16-23)"
__t=$SECONDS; __rc=0; "$BUN" run scripts/core-runtime/prove-metering-s3-truth.ts || { __rc=$?; fail=1; }; prover_mark scripts/core-runtime/prove-metering-s3-truth.ts "$__t" "$__rc"
__t=$SECONDS; __rc=0; "$BUN" run scripts/core-runtime/prove-resize-hold-cursor.ts || { __rc=$?; fail=1; }; prover_mark scripts/core-runtime/prove-resize-hold-cursor.ts "$__t" "$__rc"

__t=$SECONDS; __rc=0; "$BUN" run scripts/core-runtime/prove-terminal-backpressure.ts || { __rc=$?; fail=1; }; prover_mark scripts/core-runtime/prove-terminal-backpressure.ts "$__t" "$__rc"

if [ "$fail" = "0" ]; then echo "core-runtime suite: green"; else echo "core-runtime suite: RED"; fi
exit "$fail"
