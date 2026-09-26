#!/usr/bin/env bash
# gate-class: cpu
# gate-watch: src/components/tasks/RunDetailPane* src/components/tasks/WorkflowDetailDialog*
# gate-watch: src/daemon/workerRecon* src/tasks/LocalWorkflowTask/LocalWorkflowTask*
# gate-watch: src/tools/WorkflowTool/** src/utils/evolution/evolutionLedger*
# gate-watch: scripts/crew/team-world.ts scripts/daemon/dupline-world.ts scripts/lib/* src/bootstrap/state.ts
# gate-watch: src/components/HelmTelemetryRail.tsx src/components/MercuryFrame.tsx
# gate-watch: src/services/capacity/governor.ts src/services/concourse/workerModels.ts
# gate-watch: src/services/providers/anthropic/streamCore.ts src/services/providers/openai/openaiLimitState.ts
# gate-watch: src/state/AppStateStore.ts src/tasks.ts src/tools/AgentTool/runAgent.ts
# gate-watch: src/tools/SendMessageTool/SendMessageTool.ts src/utils/cwd.ts src/utils/task/workRoster.ts
# gate-watch: src/components/tasks/WorkflowsBoard.tsx src/ink.ts src/ink/components/StdinContext.ts
# gate-watch: src/state/AppState.tsx src/utils/config.ts
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss rc=%s\n' "$p" "$(( SECONDS - $2 ))" "${3:?proof exit code required}"; }

here="$(cd "$(dirname "$0")" && pwd)"
bun="${BUN:-$HOME/.bun/bin/bun}"
fail=0
echo "############################################################"
echo "# Workflow engine extensions — proof harness"
echo "############################################################"
shopt -s nullglob
for proof in "$here"/prove-*.ts; do
  echo
  echo ">>> $(basename "$proof")"
  __t=$SECONDS; __rc=0; "$bun" run "$proof" || { __rc=$?; fail=1; }; prover_mark "$proof" "$__t" "$__rc"
done
echo "############################################################"
if [ "$fail" = "0" ]; then echo "# ✅ ALL WORKFLOW-EXTENSION PROOFS PASS"; else echo "# ❌ SOME WORKFLOW-EXTENSION PROOFS FAILED"; fi
echo "############################################################"
exit "$fail"
