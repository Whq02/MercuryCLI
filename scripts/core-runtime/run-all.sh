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
# gate-watch: scripts/ink-runtime/ansiEmulator.ts scripts/ink-runtime/frameHarness.ts
# gate-watch: src/services/tools/loopGuard* src/services/tools/toolExecution*
# gate-watch: src/run-core/pauseGate* src/run-core/turn-machine* src/services/tools/toolOrchestration*
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
__t=$SECONDS; __rc=0; "$BUN" run scripts/core-runtime/prove-compose-clip-memo.ts || { __rc=$?; fail=1; }; prover_mark scripts/core-runtime/prove-compose-clip-memo.ts "$__t" "$__rc"

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

echo "── core-runtime: the pause gate parks every loop at its two safe points"
__t=$SECONDS; __rc=0; "$BUN" run scripts/core-runtime/prove-pause-gate.ts || { __rc=$?; fail=1; }; prover_mark scripts/core-runtime/prove-pause-gate.ts "$__t" "$__rc"

echo "── core-runtime: the queue owner refuses a sub-agent the operator's line"
__t=$SECONDS; __rc=0; "$BUN" run scripts/core-runtime/prove-drain-owner-guard.ts || { __rc=$?; fail=1; }; prover_mark scripts/core-runtime/prove-drain-owner-guard.ts "$__t" "$__rc"

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
__t=$SECONDS; __rc=0; "$BUN" run scripts/core-runtime/prove-notification-settle.ts || { __rc=$?; fail=1; }; prover_mark scripts/core-runtime/prove-notification-settle.ts "$__t" "$__rc"
__t=$SECONDS; __rc=0; "$BUN" run scripts/core-runtime/prove-wake-hold.ts || { __rc=$?; fail=1; }; prover_mark scripts/core-runtime/prove-wake-hold.ts "$__t" "$__rc"

echo "── core-runtime: the loop guard (the identical-call reminder at 3, 5 and 8; the cycle-of-k detector)"
__t=$SECONDS; __rc=0; "$BUN" run scripts/core-runtime/prove-loop-guard-reminder.ts || { __rc=$?; fail=1; }; prover_mark scripts/core-runtime/prove-loop-guard-reminder.ts "$__t" "$__rc"
__t=$SECONDS; __rc=0; "$BUN" run scripts/core-runtime/prove-loop-guard-cycle.ts || { __rc=$?; fail=1; }; prover_mark scripts/core-runtime/prove-loop-guard-cycle.ts "$__t" "$__rc"
__t=$SECONDS; __rc=0; "$BUN" run scripts/core-runtime/prove-loop-guard-headless.ts || { __rc=$?; fail=1; }; prover_mark scripts/core-runtime/prove-loop-guard-headless.ts "$__t" "$__rc"
__t=$SECONDS; __rc=0; "$BUN" run scripts/core-runtime/prove-loop-guard-chant.ts || { __rc=$?; fail=1; }; prover_mark scripts/core-runtime/prove-loop-guard-chant.ts "$__t" "$__rc"

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

echo "── core-runtime: the ledger on resume (the raw records, not the project slot)"
__t=$SECONDS; __rc=0; "$BUN" run scripts/core-runtime/prove-ledger-resume-rebuild.ts || { __rc=$?; fail=1; }; prover_mark scripts/core-runtime/prove-ledger-resume-rebuild.ts "$__t" "$__rc"

echo "── core-runtime: the served-model law (the stamp and the bill follow the serving model)"
__t=$SECONDS; __rc=0; "$BUN" run scripts/core-runtime/prove-served-model.ts || { __rc=$?; fail=1; }; prover_mark scripts/core-runtime/prove-served-model.ts "$__t" "$__rc"

echo "── core-runtime: the post-idle thinking drop reads as an ordinary preserved-thinking notice (no independent idle arming)"
__t=$SECONDS; __rc=0; "$BUN" run scripts/core-runtime/prove-idle-drop-receipt.ts || { __rc=$?; fail=1; }; prover_mark scripts/core-runtime/prove-idle-drop-receipt.ts "$__t" "$__rc"

echo "── core-runtime: the fork's usage fold (FN-018 rank 8)"
__t=$SECONDS; __rc=0; "$BUN" run scripts/core-runtime/prove-fork-usage-fold.ts || { __rc=$?; fail=1; }; prover_mark scripts/core-runtime/prove-fork-usage-fold.ts "$__t" "$__rc"

echo "── core-runtime: the metering S3 rows (FN-018 ranks 16-23)"
__t=$SECONDS; __rc=0; "$BUN" run scripts/core-runtime/prove-metering-s3-truth.ts || { __rc=$?; fail=1; }; prover_mark scripts/core-runtime/prove-metering-s3-truth.ts "$__t" "$__rc"
__t=$SECONDS; __rc=0; "$BUN" run scripts/core-runtime/prove-resize-hold-cursor.ts || { __rc=$?; fail=1; }; prover_mark scripts/core-runtime/prove-resize-hold-cursor.ts "$__t" "$__rc"

__t=$SECONDS; __rc=0; "$BUN" run scripts/core-runtime/prove-compact-resize-rig.ts || { __rc=$?; fail=1; }; prover_mark scripts/core-runtime/prove-compact-resize-rig.ts "$__t" "$__rc"

echo "── core-runtime: scheduled work bills under the cron workload and shows in its own bucket"
__t=$SECONDS; __rc=0; "$BUN" run scripts/core-runtime/prove-cron-billing.ts || { __rc=$?; fail=1; }; prover_mark scripts/core-runtime/prove-cron-billing.ts "$__t" "$__rc"

if [ "$fail" = "0" ]; then echo "core-runtime suite: green"; else echo "core-runtime suite: RED"; fi
exit "$fail"
