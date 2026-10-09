#!/usr/bin/env bash
# gate-class: pty
# gate-watch: src/components/** src/keybindings/**
# gate-watch: src/utils/mercuryTokens* src/utils/helmDensity* src/utils/helmGeometry*
# gate-watch: src/utils/transcriptSearch* src/utils/cockpit/cockpitActivity*
# gate-watch: src/input-core/command-queue* src/run-core/attachment-drain*
# gate-watch: src/run-core/turn-machine*
# gate-watch: src/tools/SleepTool/** src/services/providers/zai/** src/utils/router/providers/zai*
# gate-watch: src/screens/Chat* design-system/readme.md src/tools.ts src/tools/**
# gate-watch: src/services/workbench/** src/utils/artifacts/** src/commands/diff/**
# gate-watch: scripts/engine-durability/bench-prompt-attribution.ts scripts/engine-durability/harness.ts
# gate-watch: scripts/gate/ledger.ts scripts/lib/* scripts/ui/vshot.py
# gate-watch: src/rows/* src/runner/wire/*
# gate-watch: src/utils/cockpit/helmLanesModel.ts
# gate-watch: src/Task.ts src/bootstrap/state.ts src/commands/workbench/workbench.tsx src/constants/subagentDoctrine.ts
# gate-watch: src/context/overlayStack.ts src/hooks/useTurnEndPing.ts src/ink.ts src/ink/root/frame-trace.ts src/ink/session/focus-store.ts
# gate-watch: src/ink/session/terminalProfile.ts src/ink/session/windowsHostSetup.ts src/interactiveHelpers.tsx src/services/attention/statusFeed.ts
# gate-watch: src/services/run/resolveOwner.ts src/skills/bundled/index.ts src/skills/bundledSkills.ts src/utils/cockpit/critterData.ts
# gate-watch: src/utils/config/globalConfig.ts src/utils/projectConfig.ts src/utils/staticRender.tsx src/utils/toolSearch.ts src/utils/zodToJsonSchema.ts
# gate-watch: scripts/streaming/artifactArena.ts scripts/streaming/ptydrive.py scripts/streaming/screengrab.py scripts/lib/observed_walk.py scripts/lib/fixtureApi.ts scripts/lib/firstRunSeed.ts
# gate-watch: src/commands/context/context.tsx src/utils/analyzeContext.ts src/components/concourse/** src/components/mercury-ui/InteractiveRow.tsx src/daemon/controlSocket.ts src/utils/sessionStorage/paths.ts
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss rc=%s\n' "$p" "$(( SECONDS - $2 ))" "${3:?proof exit code required}"; }

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
bun="${BUN:-$HOME/.bun/bin/bun}"
fail=0

echo "############################################################"
echo "# cockpit-interaction — UI fluency, adaptive cockpit, platform parity"
echo "############################################################"

for proof in "$here"/prove-*.ts; do
  [ -e "$proof" ] || continue
  name="$(basename "$proof")"
  case "$name" in _*) continue ;; esac
  echo ""
  echo "── $name"
  __t=$SECONDS; __rc=0; if ! { "$bun" run "$proof"; __rc=$?; [ "$__rc" -eq 0 ]; }; then
    fail=1
  fi
  prover_mark "$proof" "$__t" "$__rc"
done

exit "$fail"
