#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/constants/** src/tools/AgentTool/built-in/** src/tools/AgentTool/loadAgentsDir*
# gate-watch: src/tools/WorkflowTool/agentHooks*
# gate-watch: src/prompt/mercuryContract.ts
# gate-watch: src/mneme/mnemeFrontPage.ts src/mneme/mnemeBuffer.ts src/mneme/mnemeConsolidate.ts src/mneme/mnemeGates.ts src/mneme/mnemeUsage.ts
# gate-watch: src/tools/AgentTool/agentToolUtils.ts src/tools/AgentTool/AgentTool.tsx src/tools/AgentTool/resumeAgent.ts src/tools/AgentTool/scoutPolicy.ts src/tools/AgentTool/runAgent.ts src/tools/AgentTool/prompt.ts src/tools/AgentTool/foregroundExecution.tsx docs/CREW.md src/tools.ts src/Tool.ts src/bootstrap/state.ts src/utils/config.ts
# gate-watch: src/services/providers/toolEconomy.ts src/services/providers/callModelRouter.ts src/utils/config/globalConfig.ts src/utils/messages.ts scripts/lib/hermetic.ts
# gate-watch: src/tools/AskAdvisorTool/AskAdvisorTool.ts src/tools/ComputerTool/ComputerTool.ts src/tools/ContractTool/ContractTool.ts src/tools/DebugTool/DebugTool.ts src/tools/EvalTool/EvalTool.ts src/tools/JevEvalTool/JevEvalTool.ts src/tools/JournalTool/JournalTool.ts src/tools/LSPTool/LSPTool.ts
# gate-watch: src/tools/EnterWorktreeTool/EnterWorktreeTool.ts src/tools/ExitWorktreeTool/ExitWorktreeTool.ts src/tools/TaskCreateTool/TaskCreateTool.ts src/tools/TaskGetTool/TaskGetTool.ts src/tools/TaskListTool/TaskListTool.ts src/tools/TaskUpdateTool/TaskUpdateTool.ts src/tools/ServiceTool/ServiceTool.ts
# gate-watch: src/services/run/ownerLifecycle.ts src/services/run/ownerScopedStore.ts src/services/run/resolveOwner.ts src/services/eval/kernelManager.ts src/services/eval/procKernel.ts src/services/projectServices/serviceManager.ts src/services/journeys/runner.ts
# gate-watch: src/services/browser/browserSession.ts src/services/dap/dapClient.ts src/services/primitives/evidencePlane.ts src/tasks/LocalShellTask/LocalShellTask.tsx src/tasks/LocalShellTask/killShellTasks.ts src/utils/ShellCommand.ts src/utils/task/TaskOutput.ts src/Task.ts src/utils/processGroup.ts src/utils/cleanupRegistry.ts
# gate-watch: src/tools/TaskStopTool/TaskStopTool.ts
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss rc=%s\n' "$p" "$(( SECONDS - $2 ))" "${3:?proof exit code required}"; }

here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../.." && pwd)"
bun="${BUN:-$HOME/.bun/bin/bun}"
dist="$root/dist/mercury.mjs"
fail=0
echo "############################################################"
echo "# Subagent/agent doctrine — proof harness"
echo "############################################################"

__t=$SECONDS; __rc=0; "$bun" run "$here/prove-subagent-doctrine.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-subagent-doctrine.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "$bun" run "$here/prove-crewmate-toolbox.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-crewmate-toolbox.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "$bun" run "$here/prove-crewmate-teardown.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-crewmate-teardown.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "$bun" run "$here/prove-crewmate-foreground-throw.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-crewmate-foreground-throw.ts" "$__t" "$__rc"

echo ""
echo "── dist-grep: the doctrine ships in the built product (string literals) ──"
if [ ! -f "$dist" ]; then
  echo "  [WARN] $dist not built — run 'bun run build.ts' first; skipping dist-greps"
else
  grep_ship() { # label, fixed-string
    local n; n=$(grep -Fc -- "$2" "$dist" 2>/dev/null || true)
    if [ "${n:-0}" -ge 1 ]; then echo "  [PASS] $1 (x$n)"; else echo "  [FAIL] $1 — not found in dist"; fail=1; fi
  }
  grep_ship "NORMAL subagent doctrine ships"            "one of Mercury's agents, "
  grep_ship "the clause after the seat ships"           ", spawned for one assignment, whose caller reads only the output you return"
  grep_ship "the one seat word ships"                   "a crewmate"
  grep_ship "workflow TEXT return-contract ships"       'reads your final text verbatim as its return value'
  grep_ship "workflow SCHEMA return-contract ships"     'once with the answer in the shape its input schema requires'
fi

echo "############################################################"
if [ "$fail" = "0" ]; then echo "# ✅ ALL SUBAGENT-DOCTRINE PROOFS PASS"; else echo "# ❌ SOME PROOFS FAILED"; fi
echo "############################################################"
exit "$fail"
