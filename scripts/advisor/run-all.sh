#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/services/advisor/** src/utils/model/subModelSlots.ts src/utils/messages/noticeRows.ts src/utils/messages/text.ts src/utils/workloadContext.ts src/constants/querySource.ts src/services/providers/anthropic/streamCore.ts src/utils/model/capabilities.ts src/utils/messages/apiView.ts src/types/message.ts src/components/messages/SystemTextMessage.tsx
# gate-watch: src/tools/AskAdvisorTool/** src/cli/headless/turnDriver.ts src/tools/AgentTool/runAgent.ts src/tools/WorkflowTool/agentHooks.ts src/utils/attachments/queuedCommands.ts
# gate-watch: scripts/builtin-tools/fixtures/tool-census.json src/bootstrap/state.ts src/cli/print.ts src/commands/submodels/index.ts src/commands/submodels/submodels.tsx src/components/Settings/Usage.tsx src/components/SubModelPicker.tsx src/components/messages/AttachmentMessage.tsx src/constants/tools.ts src/cost-tracker.ts src/fabric/entryCodec.ts src/ink.ts src/ink/components/StdinContext.ts src/input-core/command-queue.ts src/query.ts src/query/deps.ts src/services/compact/autoCompact.ts src/services/providers/providerUsage.ts src/state/AppStateStore.ts src/tools.ts src/utils/config.ts src/utils/config/globalConfig.ts src/utils/fileStateCache.ts src/utils/messages.ts src/utils/messages/attachmentText.ts src/utils/messages/factories.ts src/utils/modelCost.ts src/utils/sessionStorage/paths.ts src/utils/sessionStorage/writer.ts
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss rc=%s\n' "$p" "$(( SECONDS - $2 ))" "${3:?proof exit code required}"; }

cd "$(dirname "$0")/../.." || exit 1
here="$(pwd)/scripts/advisor"
bun="${BUN:-$HOME/.bun/bin/bun}"
fail=0
export MERCURY_CREDENTIAL_STORE="${MERCURY_CREDENTIAL_STORE:-file}"
shopt -s nullglob
for proof in "$here"/prove-*.ts; do
  echo
  echo ">>> $(basename "$proof")"
  __t=$SECONDS; __rc=0; "$bun" run "$proof" || { __rc=$?; fail=1; }; prover_mark "$proof" "$__t" "$__rc"
done
echo
if [ "$fail" -eq 0 ]; then echo "ADVISOR SUITE GREEN"; else echo "ADVISOR SUITE RED"; fi
exit "$fail"
