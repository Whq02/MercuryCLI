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
# Proofs for src/services/tools/* core query-loop plumbing.
# Auto-joins scripts/run-all-suites.sh (which globs scripts/*/run-all.sh).
set -uo pipefail
# One wall-seconds line per prover — the pool engine reads exactly this shape.
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss\n' "$p" "$(( SECONDS - $2 ))"; }

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
bun="${BUN:-$HOME/.bun/bin/bun}"
fail=0
# Glob every prove-*.ts so new proofs auto-join and none can be orphaned/ungated
# (an explicit list can silently strand a prover).
# Each is independent; one RED fails the suite.
for f in "$here"/prove-*.ts; do
  [ -e "$f" ] || continue
  __t=$SECONDS; "$bun" run "$f" || fail=1; prover_mark "$f" "$__t"
done
exit $fail
