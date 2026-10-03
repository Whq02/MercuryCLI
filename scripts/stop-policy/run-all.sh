#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/services/run/** src/utils/hooks/missionHook*
# gate-watch: src/utils/hooks/runStopAdapter* src/utils/hooks/runStopHook* src/utils/hooks/supervisorGate* src/query/stopHooks*
# gate-watch: src/utils/verification/verificationState* src/substrate/pidLock* src/rows/turn.ts
# gate-watch: src/services/providers/openai/openaiWire* src/services/providers/openai/openaiCallModel*
# gate-watch: src/rows/* src/runner/wire/*
# gate-watch: scripts/cache/fixtures/verdict.json scripts/node-runtime/prove-compile-cache.ts src/bootstrap/state.ts src/cli/run.ts src/constants/subagentDoctrine.ts src/entrypoints/cli.tsx
# gate-watch: src/input-core/command-queue.ts src/main.tsx src/prompt/mercuryContract.ts src/run-core/turn-machine.ts src/services/api/prefixFingerprint.ts src/services/providers/anthropic/cacheAndUsage.ts
# gate-watch: src/services/providers/anthropic/streamCore.ts src/tasks/LocalAgentTask/LocalAgentTask.tsx src/tools/AgentTool/AgentTool.tsx src/utils/activityLedger.ts src/utils/cache/cacheClock.ts src/utils/cache/cacheClockCore.ts
# gate-watch: src/utils/cache/cacheDomain.ts src/utils/config/globalConfig.ts src/utils/healthReport.ts src/utils/hooks/engine.ts src/utils/messages/streaming.ts src/utils/runPhases.ts
# gate-watch: src/utils/worktree.ts
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss rc=%s\n' "$p" "$(( SECONDS - $2 ))" "${3:?proof exit code required}"; }

here="$(cd "$(dirname "$0")" && pwd)"
bun="${BUN:-$HOME/.bun/bin/bun}"
fail=0

PROOFS=(
  prove-persistence-corpus.ts
  prove-bm-classes.ts
  prove-progress-model.ts
  prove-prefix-fingerprint.ts
  prove-surface-sweep.ts
  prove-tool-delta-grammar.ts
  prove-run-phases.ts
  prove-supervisor-gate.ts
)

echo "############################################################"
echo "# stop-policy — evidence-gated persistence proof harness"
echo "############################################################"
for proof in "${PROOFS[@]}"; do
  echo
  echo "── $proof ──"
  __t=$SECONDS; __rc=0; "$bun" run "$here/$proof" || { __rc=$?; fail=1; }; prover_mark "$here/$proof" "$__t" "$__rc"
done
exit $fail
