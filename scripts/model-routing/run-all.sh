#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/services/providers/** src/utils/router/** src/utils/model/**
# gate-watch: src/utils/modelCost.ts src/utils/context.ts src/utils/sessionRestore.ts
# gate-watch: src/utils/swarm/engineDispatch* src/utils/swarm/agentLaunchPlan*
# gate-watch: src/types/message.ts
# gate-watch: src/prompt/** src/utils/messages/pairing.ts
# gate-watch: scripts/provider-compat/fixtures/huggingface-models-2026-08-22.json src/Tool.ts
# gate-watch: src/bootstrap/state.ts src/cli/print.ts src/commands/context/context-noninteractive.ts
# gate-watch: src/commands/effort/* src/commands/model/mercuryModel.tsx src/commands/model/model.tsx
# gate-watch: src/components/* src/components/PromptInput/PromptInput.tsx src/components/Settings/Config.tsx
# gate-watch: src/components/agents/studio/StudioEditor.tsx
# gate-watch: src/components/concourse/CoordinatorModelPicker.tsx src/components/mercury-ui/EffortChip.tsx
# gate-watch: src/components/mercury-ui/HarnessChip.tsx src/components/mercury-ui/parity/HarnessView.tsx
# gate-watch: src/constants/* src/entrypoints/sdk/runtimeTypes.ts src/hooks/useDisplayedSessionModel.ts
# gate-watch: src/main.tsx src/run-core/turn-machine.ts src/screens/REPL.tsx src/services/api/errors.ts
# gate-watch: src/services/compact/autoCompact.ts src/services/concourse/coordinatorModels.ts
# gate-watch: src/services/concourse/coordinatorTools.ts src/services/engine-connector/seatProjections.ts
# gate-watch: src/services/mission/harnessApplication.ts src/services/mission/harnessProfiles.ts
# gate-watch: src/services/primitives/execution.ts src/services/primitives/executionCensus.ts
# gate-watch: src/services/search/searchDoor.ts src/tools/AgentTool/*
# gate-watch: src/tools/ToolSearchTool/ToolSearchTool.ts src/tools/WorkflowTool/agentHooks.ts
# gate-watch: src/tools/WorkflowTool/workflowPrompt.ts src/utils/* src/utils/accounts/signInLedger.ts
# gate-watch: src/utils/cockpit/effortModel.ts src/utils/messages/apiView.ts
# gate-watch: src/utils/messages/attachmentText.ts src/utils/settings/types.ts
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss rc=%s\n' "$p" "$(( SECONDS - $2 ))" "${3:?proof exit code required}"; }

here="$(cd "$(dirname "$0")" && pwd)"
bun="${BUN:-$HOME/.bun/bin/bun}"
fail=0
export MERCURY_EVOLUTION_LEDGER=0
echo "############################################################"
echo "# model-routing — native GPT primary-agency proof harness"
echo "############################################################"
shopt -s nullglob
for proof in "$here"/prove-*.ts; do
  echo
  echo ">>> $(basename "$proof")"
  __t=$SECONDS; __rc=0; "$bun" run "$proof" || { __rc=$?; fail=1; }; prover_mark "$proof" "$__t" "$__rc"
done
echo
if [ "$fail" -eq 0 ]; then
  echo "MODEL-ROUTING SUITE GREEN"
else
  echo "MODEL-ROUTING SUITE RED"
fi
exit "$fail"
