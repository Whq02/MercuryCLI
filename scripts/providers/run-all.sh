#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/services/providers/temporaryStreamError.ts src/services/providers/busyRetry.ts src/services/providers/openai/openaiWire.ts src/services/api/retryJitter.ts
# gate-watch: scripts/gate/ci-shard.sh scripts/lib/hermetic.ts
# gate-watch: scripts/provider-compat/fixtures/gemini-usage-roads-2026-09-30.json scripts/provider-compat/fixtures/huggingface-whoami-v2-documented.json
# gate-watch: src/commands/defaultprovider/defaultprovider.tsx src/state/AppState.tsx
# gate-watch: src/utils/router/modelRegistry.ts src/utils/router/providerDiscovery.ts
# gate-watch: src/utils/router/providers/deepseek.ts src/utils/router/providers/xai.ts
# gate-watch: src/utils/router/providers/zai.ts src/services/providers/zai/zaiCatalogue.ts src/utils/crew/engineDispatch.ts scripts/providers/fixtures/zai-models-2026-10-05.json
# gate-watch: src/services/providers/providerUsability* src/services/providers/providerUsage* src/services/providers/openai/openaiLimitState* src/services/engine-connector/daemonConnector*
# gate-watch: src/services/providers/accountSlots* src/components/ConsoleOAuthFlow*
# gate-watch: src/services/providers/sseDecoder*
# gate-watch: docs/ENGINES.md scripts/lib/fixtureApi.ts scripts/staleness/prove-stale-registry.ts src/*
# gate-watch: src/bootstrap/state.ts src/cli/run.ts src/commands/feedback/index.ts
# gate-watch: src/commands/login/login.tsx
# gate-watch: src/commands/model/mercuryModel.tsx src/commands/model/model.tsx src/commands/router/router.tsx
# gate-watch: src/components/* src/components/PromptInput/PromptInput.tsx src/components/Settings/Usage.tsx src/components/PromptInput/useComposerModelDoors.tsx
# gate-watch: src/components/mercury-ui/RailPanel.tsx src/components/mercury-ui/components.tsx
# gate-watch: src/components/mercury-ui/parity/AccountView.tsx src/components/tasks/useFocusedWork.ts
# gate-watch: src/constants/oauth.ts src/context/notifications.tsx src/daemon/main.ts
# gate-watch: src/daemon/sessionSeat.ts src/daemon/crewSeatPause.ts src/hooks/*
# gate-watch: src/hooks/notifs/useRateLimitWarningNotification.tsx src/ink/components/StdinContext.ts
# gate-watch: src/ink/squash-text-nodes.ts src/ink/stringWidth.ts src/keybindings/useKeybinding.ts
# gate-watch: src/run-core/turn-machine.ts src/screens/Chat.tsx src/services/* src/services/api/*
# gate-watch: src/services/concourse/workerModels.ts src/services/engine-connector/*
# gate-watch: src/services/mcp/client.ts src/services/oauth/client.ts src/services/providers/**
# gate-watch: src/services/switchboard/bootBirthFacts.ts src/services/switchboard/bornSession.ts
# gate-watch: src/services/wallet/wallet.ts src/state/telemetryBus.ts src/substrate/flagRegistry.ts
# gate-watch: src/tools/AgentTool/runAgent.ts src/tools/WebFetchTool/utils.ts src/utils/*
# gate-watch: src/utils/accounts/scopeScan.ts src/utils/accounts/signInLedger.ts
# gate-watch: src/utils/cockpit/healthCertSnapshot.ts src/utils/cockpit/quota.ts
# gate-watch: src/utils/config/globalConfig.ts src/utils/model/* src/utils/router/providerSecrets.ts
# gate-watch: src/utils/settings/mdm/settings.ts src/utils/settings/settings.ts
# gate-watch: src/utils/settings/settingsCache.ts
# gate-watch: src/commands/usage/usage.tsx
# gate-watch: src/ink/events/input-event.ts
# gate-watch: src/utils/cockpit/settingsPopup.ts
# gate-watch: src/tools/FileWriteTool/FileWriteTool.ts src/types/message.ts
# gate-watch: src/runner/wire/methods.ts
# gate-watch: src/services/providers/emptyStreamRetry.ts scripts/lib/firstRunSeed.ts scripts/lib/captureDriver.ts
# gate-watch: src/utils/cockpit/helmLanesModel.ts src/utils/cockpit/helmTelemetryModel.ts
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss rc=%s\n' "$p" "$(( SECONDS - $2 ))" "${3:?proof exit code required}"; }
here="$(cd "$(dirname "$0")" && pwd)"
bun="${BUN:-$HOME/.bun/bin/bun}"
fail=0
echo "############################################################"
echo "# providers — readiness · usage truth · slot health"
echo "############################################################"
shopt -s nullglob
for proof in "$here"/prove-*.ts; do
  echo
  echo "── $(basename "$proof") ──"
  __t=$SECONDS; __rc=0; "$bun" run "$proof" || { __rc=$?; fail=1; }; prover_mark "$proof" "$__t" "$__rc"
done
exit "$fail"
