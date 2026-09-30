#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/services/advisor/** src/utils/model/subModelSlots.ts src/utils/messages/noticeRows.ts src/utils/messages/text.ts src/utils/workloadContext.ts src/constants/querySource.ts src/services/providers/anthropic/streamCore.ts src/utils/model/capabilities.ts src/utils/messages/apiView.ts src/types/message.ts src/components/messages/SystemTextMessage.tsx
# gate-watch: src/tools/AskAdvisorTool/** src/cli/headless/turnDriver.ts src/tools/AgentTool/runAgent.ts src/tools/WorkflowTool/agentHooks.ts src/utils/attachments/queuedCommands.ts
# gate-watch: scripts/builtin-tools/fixtures/tool-census.json src/bootstrap/state.ts src/cli/print.ts src/commands/submodels/index.ts src/commands/submodels/submodels.tsx src/components/Settings/Usage.tsx src/components/SubModelPicker.tsx src/components/messages/AttachmentMessage.tsx src/constants/tools.ts src/cost-tracker.ts src/fabric/entryCodec.ts src/ink.ts src/ink/components/StdinContext.ts src/input-core/command-queue.ts src/query.ts src/query/deps.ts src/services/compact/autoCompact.ts src/services/providers/providerUsage.ts src/state/AppStateStore.ts src/tools.ts src/utils/config.ts src/utils/config/globalConfig.ts src/utils/fileStateCache.ts src/utils/messages.ts src/utils/messages/attachmentText.ts src/utils/messages/factories.ts src/utils/modelCost.ts src/utils/sessionStorage/paths.ts src/utils/sessionStorage/writer.ts
# gate-watch: scripts/lib/firstRunSeed.ts src/components/Message.tsx src/state/AppState.tsx src/utils/conversationRecovery.ts src/utils/messages/lookups.ts src/utils/messages/normalize.ts src/utils/sessionStorage/transcriptReader.ts
# gate-watch: src/utils/crewmate.ts src/utils/forkedAgent.ts
# gate-watch: src/QueryEngine.ts src/cli/headless/resume.ts src/main.tsx src/commands.ts src/commands/advise/** src/components/HelpV2/commandDomains.ts src/utils/attachments/orchestrator.ts src/utils/sessionStorage.ts src/utils/sessionStorage/resumeSnapshot.ts src/utils/sessionStoragePortable.ts
# gate-watch: src/components/App.tsx src/components/FullscreenLayout.tsx src/components/MercuryFrame.tsx src/context/surfaceRoute.ts src/hooks/useLayoutTier.ts src/ink/ink.tsx src/ink/instances.ts src/keybindings/KeybindingProviderSetup.tsx src/services/engine-connector/** src/utils/cockpit/helmFocus.ts
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss rc=%s\n' "$p" "$(( SECONDS - $2 ))" "${3:?proof exit code required}"; }

cd "$(dirname "$0")/../.." || exit 1
here="$(pwd)/scripts/advisor"
bun="${BUN:-$HOME/.bun/bin/bun}"
fail=0
export MERCURY_CREDENTIAL_STORE="${MERCURY_CREDENTIAL_STORE:-file}"
for proof in "$here"/prove-advisor-service.ts "$here"/prove-advisor-roads.ts "$here"/prove-advisor-surfaces.ts "$here"/prove-advisor-chip.ts "$here"/prove-advisor-note-lands.ts; do
  echo
  echo ">>> $(basename "$proof")"
  __t=$SECONDS; __rc=0; "$bun" run "$proof" || { __rc=$?; fail=1; }; prover_mark "$proof" "$__t" "$__rc"
done
if [ "${ADVISOR_DRIVE:-0}" = "1" ]; then
  echo
  echo ">>> prove-advise-switch-drive.ts (the real-product drive; ADVISOR_DRIVE=1 runs it once, never a gate member)"
  __t=$SECONDS; __rc=0; "$bun" run "$here/prove-advise-switch-drive.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-advise-switch-drive.ts" "$__t" "$__rc"
fi
echo
if [ "$fail" -eq 0 ]; then echo "ADVISOR SUITE GREEN"; else echo "ADVISOR SUITE RED"; fi
exit "$fail"
