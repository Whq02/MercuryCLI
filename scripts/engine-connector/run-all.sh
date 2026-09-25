#!/usr/bin/env bash
# gate-class: cpu
# gate-watch: scripts/engine-connector/**
# gate-watch: src/services/engine-connector/** src/hooks/useSessionConnector.ts
# gate-watch: src/screens/REPL.tsx src/components/MercuryFrame.tsx src/components/PromptInput/**
# gate-watch: src/components/permissions/** src/hooks/useCancelRequest.ts src/hooks/useDisplayedSessionModel.ts
# gate-watch: scripts/lib/* src/bootstrap/state.ts src/cli/print.ts src/commands/crew/index.ts
# gate-watch: src/commands/team/index.ts src/commands/teammates/index.ts src/commands/teammates/teammates.tsx
# gate-watch: src/components/* src/components/Spinner/TeammateSpinnerLine.tsx
# gate-watch: src/components/Spinner/TeammateSpinnerTree.tsx src/components/mercury-ui/SessionTabs.tsx
# gate-watch: src/components/mercury-ui/keyHintLabel.ts src/components/mercury-ui/screens/*
# gate-watch: src/components/messages/** src/components/tasks/* src/cost-tracker.ts src/daemon/*
# gate-watch: src/entrypoints/sdk/controlSchemas.ts src/entrypoints/sdk/coreSchemas.ts
# gate-watch: src/hooks/useArrowKeyHistory.tsx src/ink/session/capabilities.ts src/ink/stringWidth.ts
# gate-watch: src/ink/useTerminalNotification.ts src/input-core/interruptArity.ts
# gate-watch: src/keybindings/actionGraph.ts src/keybindings/defaultBindings.ts src/services/*
# gate-watch: src/services/concourse/sessionNaming.ts src/services/providers/catalogueEpoch.ts
# gate-watch: src/services/providers/openai/openaiCallModel.ts
# gate-watch: src/services/providers/openai/openaiCatalogue.ts src/services/providers/streamIdleBudget.ts
# gate-watch: src/state/AppState.tsx src/state/telemetryBus.ts src/substrate/flagRegistry.ts
# gate-watch: src/tasks/LocalAgentTask/LocalAgentTask.tsx src/tools/AgentTool/*
# gate-watch: src/tools/BashTool/BashTool.tsx src/tools/BashTool/backgroundRequest.ts
# gate-watch: src/tools/WorkflowTool/runManifest.ts src/utils/* src/utils/attachments/orchestrator.ts
# gate-watch: src/utils/cockpit/fleetGauge.ts src/utils/config/globalConfig.ts src/utils/crew/crewClient.ts
# gate-watch: src/utils/messages/factories.ts src/utils/model/capabilities.ts src/utils/model/configs.ts
# gate-watch: src/utils/sessionStorage/paths.ts src/utils/settings/types.ts src/utils/task/workRoster.ts
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss rc=%s\n' "$p" "$(( SECONDS - $2 ))" "${3:?proof exit code required}"; }

cd "$(dirname "$0")/../.." || exit 1
bun="${BUN:-$HOME/.bun/bin/bun}"

failed=0
shopt -s nullglob
claimed=$(cat scripts/engine-connector-*/members.txt 2>/dev/null | grep -v '^#' | grep -v '^$')

for f in scripts/engine-connector/prove-*.ts; do
  if printf '%s\n' "$claimed" | grep -qx "$(basename "$f")"; then continue; fi
  echo "── engine-connector: $(basename "$f")"
  __t=$SECONDS; __rc=0; if ! { "$bun" "$f"; __rc=$?; [ "$__rc" -eq 0 ]; }; then
    failed=1
  fi
  prover_mark "$f" "$__t" "$__rc"
done

exit "$failed"
