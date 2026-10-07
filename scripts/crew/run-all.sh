#!/usr/bin/env bash
# gate-watch: src/ink.ts
# gate-watch: src/services/providers/local/ollamaChatTransport.ts src/services/providers/openaicompat/compatChatCallModel.ts
# gate-watch: src/substrate/operationJournal.ts
# gate-class: cpu
# gate-watch: src/tools/SendMessageTool/**
# gate-watch: scripts/ui/vshot.py src/daemon/**
# gate-watch: src/utils/daemonBreaker*
# gate-watch: src/fabric/transcriptDecode.ts src/utils/sessionStorage/settledSidechainMessages.ts src/run-core/project-legacy.ts
# gate-watch: src/tasks/LocalAgentTask/launchReceipts* src/tools/AgentTool/resumeAgent*
# gate-watch: docs/SESSIONS.md scripts/daemon/dupline-world.ts scripts/lib/firstRunSeed.ts
# gate-watch: scripts/lib/fixtureApi.ts scripts/lib/captureDriver.ts src/Task.ts src/bootstrap/state.ts src/cli/run.ts
# gate-watch: src/commands/exit/exit.tsx src/components/MercuryExitConfirm.tsx
# gate-watch: src/components/PromptInput/Notifications.tsx src/components/mercury-ui/screens/CrewView.tsx
# gate-watch: src/components/mercury-ui/screens/crewPauseDoor.ts src/run-core/pauseGate.ts
# gate-watch: src/state/crewLedger.ts
# gate-watch: src/query.ts src/rows/turn.ts src/cli/headless/turnDriver.ts
# gate-watch: src/screens/Chat.tsx src/components/messages/TranscriptNameplate.tsx src/utils/staticRender.tsx
# gate-watch: src/tools/WorkflowTool/runControl.ts src/tools/WorkflowTool/WorkflowTool.tsx
# gate-watch: src/components/messages/UserAgentNotificationMessage.tsx src/fabric/entryCodec.ts
# gate-watch: src/fabric/ordinal.ts src/hooks/useCancelRequest.ts src/input-core/command-queue.ts
# gate-watch: src/services/agentResults/normalize.ts
# gate-watch: src/services/agents/operatorStop.ts src/services/api/errors.ts src/services/compact/compact.ts
# gate-watch: src/services/compact/prompt.ts src/services/concourse/workerModels.ts
# gate-watch: src/services/crew/adapters/ndjsonChild.ts src/services/crew/dispatch.ts
# gate-watch: src/services/engine-connector/* src/services/notices/idleNudge.ts
# gate-watch: src/services/notices/unreadLedger.ts src/services/resources/adapters/agent.ts
# gate-watch: src/services/resources/adapters/transcript.ts src/services/resources/contracts.ts
# gate-watch: src/state/AppStateStore.ts src/state/crewLedger.ts src/substrate/flagRegistry.ts src/substrate/storeRecovery.ts
# gate-watch: src/tasks.ts src/tasks/LocalAgentTask/* src/tasks/LocalMainSessionTask.ts
# gate-watch: src/tasks/LocalWorkflowTask/LocalWorkflowTask.tsx src/tasks/stopTask.ts src/tools/AgentTool/*
# gate-watch: src/tools/AgentTool/built-in/mercuryCrewAgent.ts
# gate-watch: src/types/ids.ts src/utils/*
# gate-watch: src/utils/accounts/signInLedger.ts src/utils/attachments/orchestrator.ts
# gate-watch: src/utils/config/globalConfig.ts src/utils/messages/* src/utils/model/computedDefault.ts
# gate-watch: src/utils/model/configs.ts src/utils/sessionStorage/logs.ts src/utils/sessionStorage/paths.ts
# gate-watch: src/utils/task/*
# gate-watch: src/components/PromptInput/PromptInput.tsx src/components/tasks/crewmateInterrupt.ts src/state/selectors.ts src/state/crewmateViewHelpers.ts src/utils/attachments/queuedCommands.ts src/utils/cockpit/crewmateWords.ts src/components/PromptInput/useComposerSubmit.ts
# gate-watch: src/components/tasks/useCrewmateTranscript.ts
# gate-watch: package.json scripts/builtin-tools/fixtures/tool-census.json scripts/builtin-tools/fixtures/tool-census.md scripts/project-services/fixtures/inventory.json
# gate-watch: src/components/mercury-ui/toolGlyphs.ts src/components/messages/AssistantToolUseMessage.tsx src/state/AppState.tsx src/substrate/durableOperationMatrix.ts src/tools.ts src/tools/MCPTool/absentToolShim.ts
# gate-watch: src/utils/capability/declarations.ts src/utils/permissions/readOnlyAllowlist.ts src/utils/crew/agentLaunchPlan.ts
# gate-watch: src/utils/hooks/events.ts src/services/oauth/client.ts
# gate-watch: src/utils/tasks.ts src/utils/agentContext.ts
# gate-watch: src/commands/tasks/index.ts src/components/tasks/BackgroundTasksDialog.tsx src/services/crew/identity.ts
# gate-watch: scripts/lib/scriptedTurn.ts src/utils/crew/crewStart.ts src/utils/crew/crewWorktreeReminder.ts
# gate-watch: src/utils/crew/crewAccountChange.ts
# gate-watch: docs/CREW.md docs/ENGINES.md README.md src/main.tsx src/setup.ts src/components/Settings/Config.tsx src/utils/config/schema.ts
# gate-watch: scripts/lib/rows.ts
# gate-watch: src/rows/* src/runner/wire/*
# gate-watch: scripts/lib/runnerHost.ts
# gate-watch: scripts/lib/seatDoor.ts
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss rc=%s\n' "$p" "$(( SECONDS - $2 ))" "${3:?proof exit code required}"; }

here="$(cd "$(dirname "$0")" && pwd)"
bun="${BUN:-$HOME/.bun/bin/bun}"
fail=0
export MERCURY_EVOLUTION_LEDGER=0
scratch_home="$(mktemp -d "${TMPDIR:-/tmp}/crew-proof-home.XXXXXX")"
export MERCURY_CONFIG_DIR="$scratch_home"
unset MERCURY_DAEMON_PERMISSION_MODE MERCURY_WORKER_RECON_ALLOW 2>/dev/null || true
trap 'rm -rf "$scratch_home"; suite_home_cleanup' EXIT
echo "############################################################"
echo "# Crewmates — proof harness"
echo "############################################################"
shopt -s nullglob
globs=("$here"/prove-*.ts)
[ "${UI_RENDER:-0}" = "1" ] && globs+=("$here"/render-*.ts)
for proof in "${globs[@]}"; do
  echo
  echo ">>> $(basename "$proof")"
  __t=$SECONDS; __rc=0; "$bun" run "$proof" || { __rc=$?; fail=1; }; prover_mark "$proof" "$__t" "$__rc"
done
echo "############################################################"
if [ "$fail" = "0" ]; then echo "# ✅ ALL CREW PROOFS PASS"; else echo "# ❌ SOME CREW PROOFS FAILED"; fi
echo "############################################################"
exit "$fail"
