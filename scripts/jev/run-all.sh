#!/usr/bin/env bash
# gate-class: cpu
# gate-watch: src/services/jev/** src/tools/JevEvalTool/** src/commands/jev/**
# gate-watch: src/utils/router/providerSecrets.ts src/bootstrap/state.ts
# gate-watch: src/components/Settings/Jev.tsx src/components/Settings/Usage.tsx src/components/Settings/Config.tsx src/services/engine-connector/seatWire.ts src/services/engine-connector/types.ts
# gate-watch: scripts/lib/settingsPopupHarness.ts scripts/settings/prove-usage-popup.ts src/* src/cli/print.ts
# gate-watch: src/commands/config/config.tsx src/commands/usage/usage.tsx src/components/*
# gate-watch: src/components/PromptInput/PromptInput.tsx src/components/Settings/Settings.tsx
# gate-watch: src/components/design-system/ThemeProvider.tsx src/components/tasks/CompactWorkSummary.tsx
# gate-watch: src/context/surfaceRoute.ts src/hooks/* src/input-core/pending-input.ts
# gate-watch: src/keybindings/KeybindingProviderSetup.tsx src/services/engine-connector/focusedConnector.ts
# gate-watch: src/services/engine-connector/noSessionConnector.ts src/services/providers/providerUsage.ts
# gate-watch: src/services/switchboard/capacityCheck.ts src/state/AppState.tsx src/state/AppStateStore.ts
# gate-watch: src/substrate/startupMenu.ts src/tools/AgentTool/agentToolUtils.ts src/utils/*
# gate-watch: src/utils/capability/census.ts src/utils/capability/contract.ts src/utils/cockpit/*
# gate-watch: src/utils/config/globalConfig.ts src/utils/permissions/classifierDecision.ts
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss rc=%s\n' "$p" "$(( SECONDS - $2 ))" "${3:?proof exit code required}"; }

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
bun="${BUN:-$HOME/.bun/bin/bun}"
fail=0
for f in "$here"/prove-*.ts; do
  [ -e "$f" ] || continue
  __t=$SECONDS; __rc=0; "$bun" run "$f" || { __rc=$?; fail=1; }; prover_mark "$f" "$__t" "$__rc"
done
exit $fail
