#!/usr/bin/env bash
# gate-class: cpu
# gate-watch: src/Tool* src/bootstrap/state* src/services/mcp/registry/serverRegistry*
# gate-watch: src/services/run/effectObserver* src/services/tools/toolExecution*
# gate-watch: src/tasks/LocalWorkflowTask/LocalWorkflowTask* src/tools/AgentTool/AgentTool*
# gate-watch: src/tools/AskUserQuestionTool/AskUserQuestionTool* src/tools/BriefTool/BriefTool*
# gate-watch: src/tools/DebugTool/DebugTool* src/tools/MonitorTool/**
# gate-watch: src/tools/SleepTool/SleepTool* src/tools/TaskOutputTool/TaskOutputTool*
# gate-watch: src/tools/ToolSearchTool/ToolSearchTool* src/tools/ToolSearchTool/cooccurPrior*
# gate-watch: src/tools/WorkflowTool/** src/utils/**
# gate-watch: src/tools/TaskStopTool/* src/tasks/stopTask* src/tasks/taskOutcomeEnvelope*
# gate-watch: src/tools/GrepTool/**
# gate-watch: docs/TERMINAL-RUNTIME.md scripts/builtin-tools/fixtures/tool-census.json
# gate-watch: scripts/daemon/dupline-world.ts scripts/lib/hermetic.ts scripts/lib/scriptedTurn.ts src/*
# gate-watch: src/cli/headless/controlHandlers.ts src/cli/headless/turnDriver.ts src/components/*
# gate-watch: src/components/CustomSelect/select.tsx src/components/Spinner/utils.ts
# gate-watch: src/components/design-system/ProgressBar.tsx src/components/mercury-ui/toolGlyphs.ts
# gate-watch: src/components/messages/AssistantToolUseMessage.tsx
# gate-watch: src/components/messages/CollapsedReadSearchContent.tsx
# gate-watch: src/components/permissions/FilePermissionDialog/useFilePermissionDialog.ts
# gate-watch: src/components/tasks/WorkflowsBoard.tsx src/constants/** src/daemon/* src/fabric/entryCodec.ts
# gate-watch: src/fabric/ordinal.ts src/hooks/* src/hooks/toolPermission/handlers/interactiveHandler.ts
# gate-watch: src/ink/components/App.tsx src/ink/ink.tsx src/ink/session/capabilities.ts
# gate-watch: src/ink/stringWidth.ts src/input-core/command-queue.ts
# gate-watch: src/keybindings/KeybindingProviderSetup.tsx src/memdir/mnemeConsolidate.ts
# gate-watch: src/query/stopHooks.ts src/run-core/model-lane.ts src/run-core/turn-machine.ts
# gate-watch: src/screens/REPL.tsx src/screens/toolJsxArbitration.ts src/services/agents/watch.ts
# gate-watch: src/services/concourse/concourseSnapshot.ts src/services/concourse/workerTranscript.ts
# gate-watch: src/services/coordination/coordinationService.ts src/services/dap/dapClient.ts
# gate-watch: src/services/lsp/LSPDiagnosticRegistry.ts src/services/lsp/manager.ts src/services/mcp/client.ts
# gate-watch: src/services/mcp/useManageMCPConnections.ts src/services/memoryUpkeep/consolidationLock.ts
# gate-watch: src/services/privateChannel/quietUpdateNotice.ts src/services/providers/*
# gate-watch: src/services/providers/anthropic/** src/services/providers/openai/*
# gate-watch: src/services/providers/zai/zaiCodec.ts src/services/resources/registry.ts
# gate-watch: src/services/tools/toolOrchestration.ts src/services/vulcan/portabilityDoctor.ts
# gate-watch: src/state/AppState.tsx src/state/AppStateStore.ts src/substrate/flagRegistry.ts
# gate-watch: src/tasks/LocalAgentTask/LocalAgentTask.tsx src/tools/** src/types/logs.ts src/vim/types.ts
# gate-watch: src/components/messages/AttachmentMessage.tsx src/components/messages/TranscriptNameplate.tsx
# gate-watch: src/fabric/transcriptDecode.ts src/fabric/validate.ts src/services/tools/toolHooks.ts
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
