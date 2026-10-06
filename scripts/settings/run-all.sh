#!/usr/bin/env bash
# gate-class: pure
# gate-watch: scripts/lib/hermetic.ts scripts/providers/lib/xai-usage-fixture.ts scripts/providers/lib/xai-auth-fixture.ts src/services/providers/xai/xaiOauth.ts
# gate-watch: scripts/provider-compat/fixtures/huggingface-whoami-v2-documented.json
# gate-watch: scripts/providers/fixtures/anthropic-oauth-usage.json scripts/providers/fixtures/openai-chatgpt-usage.json
# gate-watch: src/context/modalContext.tsx src/services/providers/credentialEnvSpellings.ts
# gate-watch: src/services/providers/patience.ts
# gate-watch: src/bootstrap/state* src/bootstrap/runtime/posture.ts
# gate-watch: src/state/AppStateStore.ts
# gate-watch: src/utils/settings/** src/utils/config/** src/utils/config.ts src/services/compact/autoCompact.ts src/components/Settings/Config.tsx
# gate-watch: src/utils/fileRead* scripts/lib/scratchSeat.ts src/mneme/paths.ts
# gate-watch: src/migrations/**
# gate-watch: src/components/BootSettingsScreen* src/services/switchboard/capacityCheck*
# gate-watch: src/components/Settings/** src/services/providers/providerUsage* src/commands/usage/**
# gate-watch: src/services/providers/accountSlots* src/components/mercury-ui/parity/AccountView*
# gate-watch: src/components/HelmTelemetryRail* src/components/BootLoginsScreen* src/components/BootSplashScreen* src/services/wallet/** src/utils/accounts/** src/utils/auth.ts
# gate-watch: src/cli/handlers/auth.ts src/utils/status.tsx src/state/AppState.tsx src/cli/sessionArgs.ts
# gate-watch: src/cli/run.ts src/cli/headless/controlHandlers.ts src/daemon/sessionSeat.ts src/daemon/concourseWorkers.ts src/services/engine-connector/** src/screens/Chat.tsx src/components/MercuryFrame.tsx src/components/tasks/BackgroundTasksDialog.tsx src/components/mercury-ui/screens/CrewView.tsx
# gate-watch: scripts/lib/codeText.ts scripts/lib/settingsPopupHarness.ts
# gate-watch: scripts/lib/fixtureApi.ts scripts/lib/runnerHost.ts src/services/providers/openai/openaiCatalogue.ts src/services/providers/catalogueOnDemand.ts src/hooks/useCatalogueEpoch.ts src/services/providers/moonshot/moonshotAccounts.ts src/services/providers/huggingface/huggingfaceAccounts.ts src/services/providers/huggingface/huggingfaceCatalogue.ts src/services/providers/local/localDiscovery.ts src/services/providers/local/localAccounts.ts src/components/ConfigurableShortcutHint.tsx src/components/HelmLanesRail.tsx
# gate-watch: scripts/providers/lib/usage-plan-world.ts src/* src/commands/config/config.tsx
# gate-watch: src/components/InvalidConfigDialog.tsx src/components/InvalidSettingsDialog.tsx src/components/SettingsPopupSlot.tsx src/context/popupFormContext.ts
# gate-watch: src/components/design-system/ThemeProvider.tsx src/components/mercury-ui/RailPanel.tsx
# gate-watch: src/components/mercury-ui/components.tsx src/components/tasks/useFocusedWork.ts
# gate-watch: src/context/notifications.tsx src/entrypoints/init.ts src/hooks/useExitOnCtrlCD.ts
# gate-watch: src/ink/components/App.tsx src/ink/components/StdinContext.ts src/ink/recessLayer.ts
# gate-watch: src/ink/squash-text-nodes.ts src/keybindings/useKeybinding.ts src/keybindings/writeBindings.ts
# gate-watch: src/services/anthropicLimits.ts src/services/engine-connector/focusedConnector.ts
# gate-watch: src/services/instructions/* src/services/instructions/adapters/**
# gate-watch: src/services/mcp/anthropicConnectors.ts src/services/providers/openai/openaiLimitState.ts
# gate-watch: src/services/providers/usageFreshness.ts src/state/telemetryBus.ts src/utils/*
# gate-watch: src/utils/cockpit/* src/utils/model/computedDefault.ts src/utils/permissions/PermissionUpdate.ts src/utils/permissions/PermissionMode.ts
# gate-watch: src/utils/permissions/bypassPermissionsKillswitch.ts src/utils/permissions/permissionSetup.ts src/utils/router/providerDiscovery.ts
# gate-watch: src/services/providers/providerIdentityLine.ts src/services/providers/moonshot/** src/services/providers/huggingface/** src/services/providers/gemini/** src/services/providers/openrouter/** src/services/providers/local/** src/services/providers/openaicompat/** src/services/providers/deepseek/** src/utils/router/providerSecrets.ts src/utils/router/modelRegistry.ts src/ink/events/input-event.ts src/ink/input/interpreter.ts
# gate-watch: src/services/localServer/** src/services/providers/catalogueOnDemand.ts
# gate-watch: src/commands/localsetup/** src/components/LocalSetupDialog.tsx src/components/BootSaturnScreen.tsx src/components/HelpV2/commandDomains.ts src/components/MercuryModelPicker.tsx
# gate-watch: src/utils/model/modelOptions.ts src/utils/model/model.ts src/commands/model/persistModelChoice.ts
# gate-watch: src/components/DeckPane.tsx src/hooks/useDisplayedSessionModel.ts src/hooks/useEngineModel.ts src/hooks/useProviderUsageOnShow.ts src/services/advisor/index.ts
# gate-watch: src/rows/* src/runner/wire/* scripts/lib/rows.ts
# gate-watch: docs/SETTINGS.md docs/SESSIONS.md scripts/lib/fixtureApi.ts src/utils/sessionStorage/paths.ts src/utils/cleanup.ts
# gate-watch: src/schemas/hooks.ts src/utils/hooks/matching.ts src/utils/hooks/matcherGrammar.ts
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss rc=%s\n' "$p" "$(( SECONDS - $2 ))" "${3:?proof exit code required}"; }

here="$(cd "$(dirname "$0")" && pwd)"
bun="${BUN:-$HOME/.bun/bin/bun}"
fail=0
echo "############################################################"
echo "# settings — configuration pipeline proof harness"
echo "############################################################"
shopt -s nullglob
export TZ=UTC LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8
for proof in "$here"/prove-*.ts; do
  echo
  echo "── $(basename "$proof") ──"
  __t=$SECONDS; __rc=0; "$bun" run "$proof" || { __rc=$?; fail=1; }; prover_mark "$proof" "$__t" "$__rc"
done
exit $fail
