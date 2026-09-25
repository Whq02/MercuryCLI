#!/usr/bin/env bash
# gate-class: cpu
# gate-watch: scripts/model-transition/**
# gate-watch: src/utils/model/modelTransition.ts src/services/run/requestContextPlan.ts
# gate-watch: src/fabric/** src/utils/sessionStorage/** src/services/providers/**
# gate-watch: src/services/branches/** src/services/run/contextSelection.ts
# gate-watch: .github/workflows/windows-ui.yml scripts/consistency-census/gen-lockup-census.ts
# gate-watch: scripts/consistency-census/prove-lockup-census.ts scripts/crew/run-all.sh
# gate-watch: scripts/helm-console/run-all.sh scripts/lib/codeText.ts scripts/release/launcherTemplates.mjs
# gate-watch: scripts/session-graph/prove-resize-continuity.ts scripts/ui/* src/bootstrap/state.ts
# gate-watch: src/commands/branch/branch.ts src/commands/crew/index.ts src/commands/login/login.tsx
# gate-watch: src/commands/mock-limits/index.ts src/commands/model/mercuryModel.tsx
# gate-watch: src/commands/model/model.tsx src/commands/rewind/index.ts src/components/*
# gate-watch: src/components/CustomSelect/SelectMulti.tsx
# gate-watch: src/components/CustomSelect/use-multi-select-state.ts src/components/PromptInput/PromptInput.tsx
# gate-watch: src/components/design-system/Dialog.tsx src/components/mercury-ui/FailoverMark.tsx
# gate-watch: src/components/messages/* src/hooks/useDisplayedSessionModel.ts src/ink/input/scanner.ts
# gate-watch: src/interactiveHelpers.tsx src/keybindings/defaultBindings.ts src/query/deps.ts
# gate-watch: src/query/scriptedStream.ts src/run-core/call-reference.ts src/run-core/turn-machine.ts
# gate-watch: src/screens/REPL.tsx src/services/* src/services/acp/acpServer.ts src/services/api/*
# gate-watch: src/services/compact/autoCompact.ts src/services/crew/*
# gate-watch: src/services/engine-connector/daemonConnector.ts
# gate-watch: src/services/engine-connector/focusedConnector.ts src/services/instructions/* src/services/run/*
# gate-watch: src/services/tips/tipRegistry.ts src/state/AppStateStore.ts src/substrate/flagRegistry.ts
# gate-watch: src/substrate/startupMenu.ts src/tasks.ts src/tools/AgentTool/prompt.ts
# gate-watch: src/tools/AgentTool/runAgent.ts src/tools/PowerShellTool/PowerShellTool.tsx
# gate-watch: src/tools/SetTierTool/SetTierTool.ts src/types/message.ts src/utils/*
# gate-watch: src/utils/autopilot/tierState.ts src/utils/config/globalConfig.ts src/utils/messages/*
# gate-watch: src/utils/model/* src/utils/shell/powershellProvider.ts src/utils/shell/shellToolUtils.ts
# gate-watch: src/utils/task/diskOutput.ts
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss rc=%s\n' "$p" "$(( SECONDS - $2 ))" "${3:?proof exit code required}"; }

cd "$(dirname "$0")/../.." || exit 1
bun="${BUN:-$HOME/.bun/bin/bun}"

failed=0
shopt -s nullglob
for f in scripts/model-transition/prove-*.ts; do
  echo "── model-transition: $(basename "$f")"
  __t=$SECONDS; __rc=0; if ! { "$bun" "$f"; __rc=$?; [ "$__rc" -eq 0 ]; }; then
    failed=1
  fi
  prover_mark "$f" "$__t" "$__rc"
done

exit "$failed"
