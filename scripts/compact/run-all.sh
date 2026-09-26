#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/services/compact/** src/run-core/turn-machine.ts
# gate-watch: src/tools/CheckpointTool/** src/tools/RewindTool/**
# gate-watch: src/context.ts
# gate-watch: scripts/api/wire-prefix-replay.ts scripts/daemon/dupline-world.ts scripts/lib/*
# gate-watch: scripts/provider-compat/fixtures/huggingface-models-2026-08-22.json src/* src/bootstrap/state.ts
# gate-watch: src/commands/compact/** src/components/* src/components/PromptInput/Notifications.tsx
# gate-watch: src/components/messages/CompactBoundaryMessage.tsx
# gate-watch: src/components/messages/nullRenderingAttachments.ts src/constants/betas.ts
# gate-watch: src/daemon/sessionSeat.ts src/query/deps.ts src/query/transitions.ts
# gate-watch: src/run-core/project-legacy.ts src/screens/REPL.tsx src/services/api/*
# gate-watch: src/services/capacity/seatWords.ts src/services/concourse/sessionNaming.ts
# gate-watch: src/services/engine-connector/daemonConnector.ts
# gate-watch: src/services/engine-connector/noSessionConnector.ts src/services/providers/*
# gate-watch: src/services/providers/anthropic/* src/services/providers/gemini/geminiCatalogue.ts
# gate-watch: src/services/providers/huggingface/huggingfaceCatalogue.ts
# gate-watch: src/services/providers/local/localDiscovery.ts src/services/providers/openai/*
# gate-watch: src/services/providers/openaicompat/compatChatCallModel.ts
# gate-watch: src/services/providers/openaicompat/compatChatClient.ts
# gate-watch: src/services/providers/openrouter/openrouterCatalogue.ts
# gate-watch: src/services/providers/zai/zaiCallModel.ts src/services/providers/zai/zaiClient.ts
# gate-watch: src/services/run/requestContextPlan.ts src/services/run/resolveOwner.ts
# gate-watch: src/services/tokenEstimation.ts src/state/AppStateStore.ts src/substrate/flagRegistry.ts
# gate-watch: src/tasks/LocalWorkflowTask/LocalWorkflowTask.tsx src/tools/FileReadTool/FileReadTool.ts
# gate-watch: src/tools/FileReadTool/prompt.ts src/tools/ToolSearchTool/ToolSearchTool.ts src/utils/*
# gate-watch: src/utils/attachments/* src/utils/cockpit/contextGauge.ts src/utils/cockpit/helmConsole.ts
# gate-watch: src/utils/config/globalConfig.ts src/utils/messages/* src/utils/model/capabilities.ts
# gate-watch: src/utils/sessionStorage/paths.ts src/utils/swarm/inProcessRunner.ts
# gate-watch: src/utils/task/diskOutput.ts
# gate-watch: scripts/idiom/prove-body-shape-registry.ts src/fabric/validate.ts
# gate-watch: src/utils/processUserInput/processSlashCommand.tsx src/utils/sessionStorage/chain.ts
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss rc=%s\n' "$p" "$(( SECONDS - $2 ))" "${3:?proof exit code required}"; }
here="$(cd "$(dirname "$0")" && pwd)"
bun="${BUN:-$HOME/.bun/bin/bun}"
fail=0
echo "############################################################"
echo "# compact — context maintenance proofs"
echo "############################################################"
shopt -s nullglob
for proof in "$here"/prove-*.ts; do
  echo
  echo "── $(basename "$proof") ──"
  __t=$SECONDS; __rc=0; "$bun" run "$proof" || { __rc=$?; fail=1; }; prover_mark "$proof" "$__t" "$__rc"
done
exit "$fail"
