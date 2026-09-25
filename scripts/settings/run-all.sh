#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/bootstrap/state*
# gate-watch: src/utils/settings/** src/utils/config/** src/utils/config.ts
# gate-watch: src/utils/fileRead* scripts/lib/scratchSeat.ts
# gate-watch: src/migrations/**
# gate-watch: src/components/BootSettingsScreen* src/services/switchboard/capacityCheck*
# gate-watch: src/components/Settings/** src/services/providers/providerUsage* src/commands/usage/**
# gate-watch: src/services/providers/accountSlots* src/components/mercury-ui/parity/AccountView*
# gate-watch: src/components/HelmTelemetryRail* src/components/BootLoginsScreen* src/components/BootSplashScreen* src/services/wallet/** src/utils/accounts/** src/utils/auth.ts
# gate-watch: src/cli/handlers/auth.ts src/utils/status.tsx src/state/AppState.tsx
# gate-watch: scripts/lib/codeText.ts scripts/lib/settingsPopupHarness.ts
# gate-watch: scripts/providers/lib/usage-plan-world.ts src/* src/commands/config/config.tsx
# gate-watch: src/components/InvalidConfigDialog.tsx src/components/SettingsPopupSlot.tsx
# gate-watch: src/components/design-system/ThemeProvider.tsx src/components/mercury-ui/RailPanel.tsx
# gate-watch: src/components/mercury-ui/components.tsx src/components/tasks/useFocusedWork.ts
# gate-watch: src/context/notifications.tsx src/entrypoints/init.ts src/hooks/useExitOnCtrlCD.ts
# gate-watch: src/ink/components/App.tsx src/ink/components/StdinContext.ts src/ink/recessLayer.ts
# gate-watch: src/ink/squash-text-nodes.ts src/keybindings/useKeybinding.ts src/keybindings/writeBindings.ts
# gate-watch: src/services/claudeAiLimits.ts src/services/engine-connector/focusedConnector.ts
# gate-watch: src/services/instructions/* src/services/instructions/adapters/mercuryNative.ts
# gate-watch: src/services/mcp/claudeai.ts src/services/providers/openai/openaiLimitState.ts
# gate-watch: src/services/providers/usageFreshness.ts src/state/telemetryBus.ts src/utils/*
# gate-watch: src/utils/cockpit/* src/utils/model/computedDefault.ts src/utils/permissions/PermissionUpdate.ts
# gate-watch: src/utils/permissions/bypassPermissionsKillswitch.ts src/utils/router/providerDiscovery.ts
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
