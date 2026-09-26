#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/services/providers/providerUsability* src/services/providers/providerUsage* src/services/providers/openai/openaiLimitState* src/services/engine-connector/daemonConnector*
# gate-watch: src/services/providers/accountSlots* src/components/ConsoleOAuthFlow*
# gate-watch: src/services/providers/sseDecoder*
# gate-watch: docs/ENGINES.md scripts/lib/fixtureApi.ts scripts/staleness/prove-stale-registry.ts src/*
# gate-watch: src/bootstrap/state.ts src/cli/print.ts src/commands/cost/cost.ts src/commands/feedback/index.ts
# gate-watch: src/commands/login/login.tsx src/commands/mock-limits/index.ts
# gate-watch: src/commands/model/mercuryModel.tsx src/commands/model/model.tsx src/commands/router/router.tsx
# gate-watch: src/components/* src/components/PromptInput/PromptInput.tsx src/components/Settings/Usage.tsx
# gate-watch: src/components/mercury-ui/RailPanel.tsx src/components/mercury-ui/components.tsx
# gate-watch: src/components/mercury-ui/parity/AccountView.tsx src/components/tasks/useFocusedWork.ts
# gate-watch: src/constants/oauth.ts src/context/notifications.tsx src/daemon/main.ts
# gate-watch: src/daemon/sessionSeat.ts src/entrypoints/sdk/controlTypes.ts src/hooks/*
# gate-watch: src/hooks/notifs/useRateLimitWarningNotification.tsx src/ink/components/StdinContext.ts
# gate-watch: src/ink/squash-text-nodes.ts src/ink/stringWidth.ts src/keybindings/useKeybinding.ts
# gate-watch: src/run-core/turn-machine.ts src/screens/REPL.tsx src/services/* src/services/api/*
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
# gate-watch: src/commands/mock-limits/mock-limits.ts
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
