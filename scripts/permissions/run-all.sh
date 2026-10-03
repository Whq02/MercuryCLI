#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/Tool* src/hooks/toolPermission/handlers/interactiveHandler*
# gate-watch: src/tools/SkillTool/SkillTool*
# gate-watch: src/utils/betas* src/utils/hooks/** src/utils/messages/streaming*
# gate-watch: src/utils/permissions/classifierFailClosed* src/utils/permissions/denialTracking*
# gate-watch: src/utils/permissions/flowBlockReview* src/utils/permissions/decision/wrapper*
# gate-watch: src/utils/messages/rejectionText* src/components/permissions/PermissionRuleExplanation* src/constants/prompts*
# gate-watch: src/tools/BashTool/pathValidation* src/tools/BashTool/readOnlyValidation*
# gate-watch: scripts/lib/firstRunSeed.ts scripts/lib/fixtureApi.ts scripts/lib/seedTranscript.ts scripts/lib/runnerHost.ts
# gate-watch: scripts/api/read-instruction-heading.ts
# gate-watch: docs/TRUST.md
# gate-watch: src/mneme/mnemeGates.ts src/mneme/paths.ts src/tools/MemoryTools/prompt.ts src/utils/collapseReadSearch.ts src/utils/memoryFileDetection.ts
# gate-watch: src/rows/turn.ts src/bootstrap/state.ts src/cli/headless/controlHandlers.ts src/cli/headless/runnerAsks.ts src/cli/print.ts
# gate-watch: src/cli/structuredIO.ts src/commands.ts src/components/FileEditToolDiff.tsx
# gate-watch: src/components/MercuryFrame.tsx src/components/mercury-ui/compactModeChip.ts
# gate-watch: src/components/permissions/** src/context.ts src/daemon/concourseSupervisor.ts src/daemon/headlessRun.ts
# gate-watch: src/daemon/permissionAsks.ts src/daemon/sessionKit.ts src/daemon/warmRunner.ts
# gate-watch: src/hooks/useCancelRequest.ts src/ink.ts
# gate-watch: src/ink/components/StdinContext.ts src/ink/components/TerminalSizeContext.tsx src/ink/stringWidth.ts
# gate-watch: src/interactiveHelpers.tsx src/main.tsx src/screens/REPL.tsx src/services/agents/codec.ts
# gate-watch: src/services/desktop/toolName.ts src/services/engine-connector/daemonConnector.ts
# gate-watch: src/services/instructions/engine.ts src/services/lsp/** src/services/mcp/** src/services/providers/**
# gate-watch: src/services/switchboard/bootBirthFacts.ts src/services/switchboard/runnerArgv.ts
# gate-watch: src/skills/loadSkillsDir.ts src/state/AppState.tsx src/state/AppStateStore.ts src/state/store.ts
# gate-watch: src/substrate/flagRegistry.ts src/tools.ts src/tools/AgentTool/** src/tools/AstEditTool/AstEditTool.ts
# gate-watch: src/tools/BashTool/** src/tools/ChangeSetTool/ChangeSetTool.ts src/tools/FileEditTool/FileEditTool.ts
# gate-watch: src/tools/FileEditTool/UI.tsx src/tools/FileWriteTool/FileWriteTool.ts src/tools/GlobTool/GlobTool.ts
# gate-watch: src/tools/NotebookEditTool/NotebookEditTool.ts src/tools/PowerShellTool/** src/types/permissions.ts src/tools/WebFetchTool/**
# gate-watch: src/utils/Shell.ts src/utils/astPatterns.ts src/utils/bash/ast.ts src/utils/browser.ts
# gate-watch: src/utils/capability/declarations.ts src/utils/cockpit/runtimePosture.ts src/utils/config/**
# gate-watch: src/utils/config.ts src/utils/cwd.ts src/utils/envUtils.ts src/utils/errors.ts src/utils/glob.ts
# gate-watch: src/utils/healthReport.ts src/utils/messages/factories.ts src/utils/messages.ts src/utils/permissions/**
# gate-watch: src/utils/platform.ts src/utils/sandbox/sandbox-adapter.ts src/utils/sessionStoragePortable.ts
# gate-watch: src/utils/settings/** src/utils/subprocessEnv.ts src/utils/suggestions/directoryCompletion.ts
# gate-watch: src/utils/swarm/agentLaunchPlan.ts src/utils/swarm/crewmateInit.ts
# gate-watch: src/utils/processUserInput/processSlashCommand.tsx src/services/crew/liveMessages.ts src/utils/conversationRecovery.ts
# gate-watch: src/daemon/controlSocket.ts src/daemon/protocol.ts src/services/engine-connector/seatProjections.ts
# gate-watch: src/components/agents/studio/StudioEditor.tsx src/components/agents/studio/AgentStudio.tsx src/components/BootAgentsScreen.tsx
# gate-watch: src/rows/* src/runner/wire/*
# gate-watch: scripts/lib/seatDoor.ts
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss rc=%s\n' "$p" "$(( SECONDS - $2 ))" "${3:?proof exit code required}"; }

here="$(cd "$(dirname "$0")" && pwd)"
bun="${BUN:-$HOME/.bun/bin/bun}"
fail=0
echo "############################################################"
echo "# Permission ladder / auto-mode — proof suite"
echo "############################################################"
for f in "$here"/prove-*.ts; do
  [ -e "$f" ] || continue
  __t=$SECONDS; __rc=0; "$bun" run "$f" || { __rc=$?; fail=1; }; prover_mark "$f" "$__t" "$__rc"
done
echo "############################################################"
if [ "$fail" = "0" ]; then echo "# ✅ ALL PERMISSION PROOFS PASS"; else echo "# ❌ SOME PERMISSION PROOFS FAILED"; fi
echo "############################################################"
exit "$fail"
