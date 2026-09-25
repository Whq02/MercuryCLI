#!/usr/bin/env bash
# gate-class: pty
# gate-watch: src/bootstrap/state.ts src/cli/headless/turnDriver.ts src/cli/print.ts
# gate-watch: src/components/MessageRow.tsx src/components/mercury-ui/screens/CrewView.tsx
# gate-watch: src/components/mercury-ui/screens/crewStopChord.ts src/components/mercury-ui/theme.ts
# gate-watch: src/components/messages/* src/components/tasks/* src/daemon/*
# gate-watch: src/entrypoints/sdk/controlSchemas.ts src/entrypoints/sdk/coreSchemas.ts
# gate-watch: src/fabric/entryCodec.ts src/fabric/ordinal.ts src/hooks/* src/main.tsx src/screens/REPL.tsx
# gate-watch: src/services/agentResults/normalize.ts src/services/agents/operatorStop.ts
# gate-watch: src/services/compact/autoCompact.ts src/services/engine-connector/*
# gate-watch: src/services/instructions/engine.ts src/services/projectIntel/snapshot.ts
# gate-watch: src/services/providers/openai/openaiCatalogue.ts src/services/resources/adapters/agent.ts
# gate-watch: src/services/resources/adapters/workflow.ts src/services/resources/contracts.ts
# gate-watch: src/services/resources/registry.ts src/services/run/* src/state/* src/tasks.ts
# gate-watch: src/tasks/LocalAgentTask/LocalAgentTask.tsx src/tasks/LocalAgentTask/agentWait.ts
# gate-watch: src/tasks/LocalShellTask/LocalShellTask.tsx src/tasks/LocalWorkflowTask/LocalWorkflowTask.tsx
# gate-watch: src/tools/AgentTool/* src/tools/BashTool/BashTool.tsx src/tools/FileWriteTool/FileWriteTool.ts
# gate-watch: src/tools/PowerShellTool/PowerShellTool.tsx src/tools/TaskCreateTool/TaskCreateTool.ts
# gate-watch: src/tools/TaskUpdateTool/TaskUpdateTool.ts src/tools/WorkflowTool/* src/types/ids.ts src/utils/*
# gate-watch: src/utils/attachments/* src/utils/config/globalConfig.ts src/utils/hooks/*
# gate-watch: src/utils/messages/factories.ts src/utils/messages/systemMessages.ts src/utils/model/agent.ts
# gate-watch: src/utils/sessionStorage/* src/utils/swarm/inProcessRunner.ts src/utils/task/workRoster.ts
# gate-watch: src/utils/verification/verificationState.ts
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"

prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss rc=%s\n' "$p" "$(( SECONDS - $2 ))" "${3:?proof exit code required}"; }

BUN="${BUN:-$HOME/.bun/bin/bun}"
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

fail=0
for proof in "$DIR"/prove-*.ts; do
  echo "── $(basename "$proof") ──"
  __t=$SECONDS; __rc=0; if ! { "$BUN" run "$proof"; __rc=$?; [ "$__rc" -eq 0 ]; }; then
    fail=1
  fi
  prover_mark "$proof" "$__t" "$__rc"
done

if [ "$fail" -eq 0 ]; then
  echo "✅ longrun-invariants suite green"
else
  echo "❌ longrun-invariants suite RED"
fi
exit "$fail"
