#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/screens/Chat* src/types/message* src/utils/messages/** src/rows/project.ts src/rows/content.ts src/rows/request.ts
# gate-watch: src/components/* src/components/concourse/CoordinatorPane.tsx
# gate-watch: src/components/messages/AssistantTextMessage.tsx src/components/messages/UserTextMessage.tsx
# gate-watch: src/components/messages/UserToolResultMessage/UserToolErrorMessage.tsx
# gate-watch: src/components/messages/UserToolResultMessage/UserToolResultMessage.tsx
# gate-watch: src/components/messages/TranscriptNameplate.tsx src/services/compact/foldStatus.ts
# gate-watch: src/components/messages/thinkingGrammar.tsx src/ink.ts
# gate-watch: src/services/engine-connector/focusedConnector.ts src/services/engine-connector/noSessionConnector.ts src/services/engine-connector/seatLive.ts
# gate-watch: src/state/AppState.tsx src/state/AppStateStore.ts src/utils/permissions/filesystem.ts
# gate-watch: src/daemon/sessionSeat.ts src/fabric/entryCodec.ts src/fabric/ordinal.ts
# gate-watch: src/query/stopHooks.ts src/run-core/turn-machine.ts
# gate-watch: src/services/api/errors.ts src/services/concourse/coordinatorCall.ts
# gate-watch: src/services/engine-connector/daemonConnector.ts src/services/engine-connector/recordIdentity.ts
# gate-watch: src/services/providers/anthropic/streamCore.ts src/services/providers/anthropic/messageParams.ts src/services/providers/openai/responsesBridge.ts src/services/providers/openai/openaiWire.ts src/services/providers/gemini/geminiCodec.ts src/services/providers/gemini/geminiClient.ts src/services/providers/zai/zaiCodec.ts src/services/providers/openaicompat/compatChatClient.ts src/services/providers/local/ollamaChatTransport.ts
# gate-watch: src/tools.ts src/tools/SkillTool/SkillTool.ts
# gate-watch: src/tools/WorkflowTool/agentTranscriptReader.ts src/utils/* src/utils/cockpit/helmConsoleAsk.ts
# gate-watch: src/utils/cockpit/turnReceipt.ts src/utils/config/globalConfig.ts
# gate-watch: src/utils/hooks/execPromptHook.ts src/utils/hooks/hookHelpers.ts
# gate-watch: src/utils/sessionStorage/chain.ts src/utils/sessionStorage/loading.ts
# gate-watch: src/Tool.ts src/bootstrap/state.ts src/fabric/record.ts src/fabric/validate.ts src/services/providers/deepseek/deepseekCallModel.ts src/services/providers/huggingface/huggingfaceCallModel.ts src/services/providers/local/localCallModel.ts src/services/providers/local/localDiscovery.ts src/services/providers/local/localWindow.ts src/services/providers/moonshot/moonshotCallModel.ts src/services/providers/openai/openaiCallModel.ts src/services/providers/openai/openaiCatalogue.ts src/services/providers/openaicompat/compatChatCallModel.ts src/services/providers/openaicompat/compatWire.ts src/services/providers/zai/zaiCallModel.ts src/services/resources/adapters/transcript.ts src/utils/model/subModelSlots.ts src/utils/sessionStorage/writer.ts
# gate-watch: src/constants/oauth.ts
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss rc=%s\n' "$p" "$(( SECONDS - $2 ))" "${3:?proof exit code required}"; }

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fail=0
echo "── message-pipeline proofs ──"
for f in "$here"/prove-*.ts; do
  [ -e "$f" ] || continue
  __t=$SECONDS; __rc=0; "${BUN:-$HOME/.bun/bin/bun}" run "$f" || { __rc=$?; fail=1; }; prover_mark "$f" "$__t" "$__rc"
done
if [[ "$fail" == "0" ]]; then echo "✅ MESSAGES SUITE GREEN"; exit 0; else
  echo "❌ MESSAGES SUITE RED"; exit 1; fi
