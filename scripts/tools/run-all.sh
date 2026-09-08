#!/usr/bin/env bash
# gate-class: cpu
# gate-watch: src/Tool* src/bootstrap/state* src/services/mcp/registry/serverRegistry*
# gate-watch: src/services/run/effectObserver* src/services/tools/toolExecution*
# gate-watch: src/tasks/LocalWorkflowTask/LocalWorkflowTask* src/tools/AgentTool/AgentTool*
# gate-watch: src/tools/AskUserQuestionTool/AskUserQuestionTool* src/tools/BriefTool/BriefTool*
# gate-watch: src/tools/DebugTool/DebugTool* src/tools/MonitorTool/MonitorTool*
# gate-watch: src/tools/SleepTool/SleepTool* src/tools/TaskOutputTool/TaskOutputTool*
# gate-watch: src/tools/ToolSearchTool/ToolSearchTool* src/tools/ToolSearchTool/cooccurPrior*
# gate-watch: src/tools/WorkflowTool/** src/utils/**
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss rc=%s\n' "$p" "$(( SECONDS - $2 ))" "${3:?proof exit code required}"; }

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
bun="${BUN:-$HOME/.bun/bin/bun}"
fail=0
for f in "$here"/prove-*.ts; do
  [ -e "$f" ] || continue
  __t=$SECONDS; __rc=0; "$bun" run "$f" || { __rc=$?; fail=1; }; prover_mark "$f" "$__t" "$__rc"
done
exit $fail
