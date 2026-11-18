#!/usr/bin/env bash
# gate-class: pure
# gate-watch: scripts/daemon/prove-unattended-ask-denied.ts scripts/settings/prove-settings-watch-beside-a-named-pipe.ts
# gate-watch: src/Tool* src/bootstrap/state* src/cli/run* src/cli/structuredIO* src/cli/ndjsonSafeStringify.ts
# gate-watch: src/tools.ts src/types/permissions.ts src/utils/permissions/permissionSetup.ts
# gate-watch: src/utils/hooks/sessionHooks* src/rows/turn.ts src/services/providers/local/localAccounts.ts scripts/headless/prove-git-readonly-settings.ts
# gate-watch: src/utils/sdkEventQueue* src/utils/task/sdkAgentFrames* src/tools/AgentTool/foregroundExecution* src/tools/AgentTool/agentToolUtils* src/cost-tracker*
# gate-watch: scripts/compact/overflowFixture.ts scripts/hooks/lib/runDoor.ts
# gate-watch: scripts/daemon/dupline-world.ts scripts/lib/* src/cli/headless/turnDriver.ts src/cli/headless/hostAskLiveness.ts src/cli/headless/runnerAsks.ts src/cli/headless/runnerMethods.ts
# gate-watch: src/input-core/command-queue.ts src/services/api/withRetry.ts src/services/api/emptyUsage.ts
# gate-watch: src/tasks/LocalAgentTask/LocalAgentTask.tsx src/tasks/LocalAgentTask/launchReceipts.ts src/run-core/attachment-drain.ts
# gate-watch: src/services/browser/browserResolver.ts src/services/compact/foldStatus.ts src/services/compact/compact.ts
# gate-watch: src/services/engine-connector/seatWire.ts src/services/mcp/client.ts src/services/mcp/types.ts
# gate-watch: src/services/providers/busyRetry.ts src/services/providers/streamIdleBudget.ts src/services/lsp/LSPClient.ts
# gate-watch: src/services/run/effectObserver.ts src/services/tools/toolExecution.ts src/utils/*
# gate-watch: src/utils/config/globalConfig.ts
# gate-watch: src/utils/permissions/filesystem.ts src/utils/permissions/ruleReason.ts src/rows/vocabulary.ts src/rows/project.ts scripts/mcp/_fixture-stdio-server.mjs
# gate-watch: src/utils/messages/rejectionText.ts src/utils/processUserInput/processUserInput.ts
# gate-watch: src/utils/task/framework.ts src/utils/shell/parentGuard.ts src/entrypoints/shellParentGuard.ts
# gate-watch: src/entrypoints/cli.tsx src/main.tsx src/setup.ts src/cli/runArgs.ts src/cli/sessionArgs.ts src/state/onChangeAppState.ts src/utils/permissions/rootNotice.ts
# gate-watch: src/services/instructions/** src/utils/processUserInput/** src/utils/config/trust.ts src/components/memory/memoryCentreLayout.ts
# gate-watch: src/tools/BashTool/pathValidation.ts src/utils/permissions/shellProtectedPaths.ts
# gate-watch: src/services/providers/openaicompat/**
# gate-watch: src/services/providers/anthropic/cacheAndUsage.ts
# gate-watch: src/rows/* src/runner/wire/* src/query/transitions.ts src/utils/messages/turnCut.ts scripts/mcp/_fixture-estate-server.mjs
# gate-watch: src/daemon/runnerConnection.ts src/daemon/headlessRun.ts src/services/acp/childSession.ts
# gate-watch: src/daemon/verbs.ts src/utils/settings/validationTips.ts
# gate-watch: src/cli/headless/restartCarry.ts src/tasks/LocalAgentTask/launchReceipts.ts
# gate-watch: sdk/src/rows.ts sdk/src/index.ts src/services/run/unansweredAsk.ts
# gate-watch: src/mneme/* src/types/textInputTypes.ts
# gate-watch: src/utils/messages/apiPlan.ts src/utils/messages/factories.ts
# gate-watch: scripts/release/launcherTemplates.mjs package.json src/services/run/unansweredAsk.ts
# gate-watch: src/run-core/attachment-drain.ts src/utils/sessionStorage/transcriptReader.ts src/services/resources/adapters/transcript.ts src/utils/messages/replyAddress.ts
# gate-watch: src/tools/BashTool/prompt.ts src/tools/BashTool/BashTool.tsx src/tools/ServiceTool/ServiceTool.ts docs/SESSIONS.md
# gate-watch: src/daemon/concourseWorkers.ts src/daemon/permissionAsks.ts src/utils/sessionKind.ts src/utils/permissions/askClock.ts src/daemon/warmRunner.ts src/services/resources/adapters/seat.ts src/substrate/flagRegistry.ts src/utils/cockpit/runtimePosture.ts
# gate-watch: src/cli/headless/sendNow.ts src/cli/run.ts src/tools/BashTool/backgroundRequest.ts src/tools/SleepTool/SleepTool.tsx
# gate-watch: src/services/providers/local/toolCallMarkup.ts src/services/providers/local/ollamaChatTransport.ts src/services/providers/emptyReply.ts src/services/api/errors.ts src/run-core/turn-machine.ts
# gate-watch: src/utils/sessionStorage/** src/cli/headless/resume.ts
# gate-watch: scripts/sdk/runtime.ts
# gate-watch: src/services/switchboard/runnerArgv.ts
# gate-watch: src/utils/cockpit/harnessMap.ts src/substrate/startupMenu.ts src/utils/attachments/orchestrator.ts
# gate-watch: scripts/provider-compat/tensorfoldPromptFixture.ts src/mneme/handoffAsk.ts src/mneme/exitHandoff.ts src/services/api/reconnectLadder.ts
# gate-watch: src/utils/health/sections/runtime.ts
# gate-watch: src/run-core/turn/**
# gate-watch: src/services/engine-connector/focusedConnector.ts
# gate-watch: src/cli/headless/*
# gate-watch: src/commands.ts src/constants/agentMessage.ts src/constants/systemPromptSections.ts src/daemon/runnerCapabilityCensus.ts src/guards/mission.ts
# gate-watch: src/run-core/pauseGate.ts src/services/advisor/index.ts src/services/agentResults/summaryRoom.ts src/services/agents/operatorStop.ts
# gate-watch: src/services/anthropicLimits.ts src/services/engine-connector/rosterTerms.ts src/services/engine-connector/seatProjections.ts
# gate-watch: src/services/mcp/config.ts src/services/mcp/elicitationHandler.ts src/services/mcp/kitCompletion.ts src/services/mcp/sessionKitPin.ts
# gate-watch: src/services/notices/idleNudge.ts src/services/notices/unreadLedger.ts src/services/providers/lawfulPrefixChange.ts
# gate-watch: src/services/providers/limitWarning.ts src/services/providers/openai/openaiCatalogue.ts src/services/providers/openai/openaiLimitState.ts
# gate-watch: src/services/providers/providerUsage.ts src/services/providers/toolEconomy.ts src/services/run/runCoordinator.ts src/services/samples/facts.ts
# gate-watch: src/services/saturn/sessionScheduleBridge.ts src/services/switchboard/sessionReceipts.ts src/services/switchboard/spawnSwitches.ts
# gate-watch: src/skills/kitGovernance.ts src/substrate/recoveryOrchestrator.ts src/tasks/LocalAgentTask/pauseCarry.ts src/tasks/LocalShellTask/guards.ts
# gate-watch: src/tasks/taskLaunchLedger.ts src/tools/AgentTool/resumeAgent.ts src/tools/MonitorTool/laneWall.ts src/tools/MonitorTool/watchReceipts.ts
# gate-watch: src/utils/crew/crewAccountChange.ts src/utils/hooks/background.ts src/utils/messages/noticeRows.ts src/utils/messages/text.ts src/utils/model/model.ts
# gate-watch: src/utils/permissions/modeTransitions.ts src/utils/skills/skillChangeDetector.ts
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss rc=%s\n' "$p" "$(( SECONDS - $2 ))" "${3:?proof exit code required}"; }

here="$(cd "$(dirname "$0")" && pwd)"
cd "$here/../.." || exit 1
bun="${BUN:-$HOME/.bun/bin/bun}"
fail=0
echo "############################################################"
echo "# headless — control protocol + batching laws"
echo "############################################################"
claimed=$(cat scripts/headless-*/members.txt 2>/dev/null | grep -v '^#' | grep -v '^$')
dupes=$(printf '%s\n' "$claimed" | sort | uniq -d)
if [ -n "$dupes" ]; then
  echo "❌ headless: prover(s) named by TWO sibling member lists (a double run across shards):"
  printf '%s\n' "$dupes" | sed 's/^/    /'
  fail=1
fi
shopt -s nullglob
for proof in "$here"/prove-*.ts; do
  printf '%s\n' "$claimed" | grep -qx "$(basename "$proof")" && continue
  echo
  echo "── $(basename "$proof") ──"
  __t=$SECONDS; __rc=0; "$bun" run "$proof" || { __rc=$?; fail=1; }; prover_mark "$proof" "$__t" "$__rc"
done
exit $fail
