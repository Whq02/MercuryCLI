#!/usr/bin/env bash
# gate-class: pure
# gate-watch: scripts/ui/** scripts/ui-pure-3/** src/bootstrap/state*
# gate-watch: src/commands/appearance/index* src/commands/health/HealthCertificate*
# gate-watch: src/commands/run/runInspectorModel*
# gate-watch: src/commands/team/index* src/components/** src/context/overlayContext*
# gate-watch: src/context/overlayStack* src/daemon/** src/hooks/useLayoutTier* src/hooks/useCwdState* src/hooks/useFocusedWorkspaceCwd* src/ink/**
# gate-watch: src/keybindings/KeybindingProviderSetup* src/services/claudeAiLimits*
# gate-watch: src/utils/ripgrep.ts src/hooks/fileSuggestions.ts
# gate-watch: src/services/rateLimitMessages* src/services/run/** src/state/AppState*
# gate-watch: src/state/AppStateStore* src/substrate/bootNotes* src/tools/BriefTool/UI*
# gate-watch: src/types/logs* src/utils/**
# gate-watch: assets/splash/splash-core.mjs design-system/live/manifest.json design-system/readme.md
# gate-watch: mercury-skills/provider-apis/SKILL.md scripts/engine-durability/harness.ts
# gate-watch: scripts/ink-runtime/ansiEmulator.ts scripts/lib/* src/commands.ts src/commands/**
# gate-watch: src/context/surfaceRoute.ts src/extensions/load/keybindings.ts src/hooks/* src/ink.ts
# gate-watch: src/input-core/pending-input.ts src/keybindings/* src/native-ts/color-diff/index.ts
# gate-watch: src/screens/** src/services/concourse/* src/services/engine-connector/*
# gate-watch: src/services/switchboard/bornSession.ts src/services/tips/tipRegistry.ts
# gate-watch: src/services/tips/tipScheduler.ts src/skills/bundled/provider-apis/SKILL.md
# gate-watch: src/state/telemetryBus.ts src/substrate/flagRegistry.ts src/tools/**
# gate-watch: design-system/live/grids/frame--120x40--dark--truecolor--full.grid.json
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss rc=%s\n' "$p" "$(( SECONDS - $2 ))" "${3:?proof exit code required}"; }

cd "$(dirname "$0")/../.." || exit 1
BUN="${BUN:-$HOME/.bun/bin/bun}"
here="scripts/ui-pure-3"

fail=0
while IFS= read -r name; do
  case "$name" in (''|'#'*) continue ;; esac
  f="scripts/ui/$name"
  if [ ! -e "$f" ]; then
    echo "❌ ui-pure-3: member '$name' has no file at $f — a stale member row is a red, never a silent skip"
    fail=1
    continue
  fi
  echo "▶ $f"
  __t=$SECONDS; __rc=0; if ! { "$BUN" run "$f"; __rc=$?; [ "$__rc" -eq 0 ]; }; then fail=1; fi; prover_mark "$f" "$__t" "$__rc"
  echo
done < "$here/members.txt"

if [ "$fail" -eq 0 ]; then echo "✅ UI-PURE-3 SUITE GREEN"; else echo "❌ UI-PURE-3 SUITE RED"; fi
exit "$fail"
