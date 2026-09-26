#!/usr/bin/env bash
# gate-class: pure
# gate-watch: scripts/ui/** scripts/ui-pure-2/** src/bootstrap/state*
# gate-watch: src/commands/appearance/index* src/commands/health/HealthCertificate*
# gate-watch: src/commands/run/runInspectorModel*
# gate-watch: src/commands/team/index* src/components/** src/context/overlayContext*
# gate-watch: src/context/overlayStack* src/daemon/** src/hooks/useLayoutTier* src/hooks/useCwdState* src/hooks/useFocusedWorkspaceCwd* src/ink/**
# gate-watch: src/keybindings/KeybindingProviderSetup* src/services/claudeAiLimits*
# gate-watch: src/utils/ripgrep.ts src/hooks/fileSuggestions.ts
# gate-watch: src/services/rateLimitMessages* src/services/run/** src/state/AppState*
# gate-watch: src/state/AppStateStore* src/substrate/bootNotes* src/tools/BriefTool/UI*
# gate-watch: src/types/logs* src/utils/**
# gate-watch: assets/splash/mercury-splash.mjs assets/splash/splash-core.mjs design-system/live/manifest.json
# gate-watch: docs/ENGINES.md scripts/critters/prove-critter-mini-drive.ts
# gate-watch: scripts/engine-durability/harness.ts scripts/ink-runtime/ansiEmulator.ts
# gate-watch: scripts/ink-runtime/prove-viewport-clamp.ts scripts/lib/* scripts/search/lib/bundle-for-node.ts
# gate-watch: src/* src/commands/accent/accent.ts src/commands/config/config.tsx
# gate-watch: src/commands/console/console.tsx src/commands/feedback/issueForms.ts
# gate-watch: src/commands/model/mercuryModel.tsx src/constants/figures.ts src/context/modalContext.tsx
# gate-watch: src/context/surfaceRoute.ts src/hooks/useCancelRequest.ts src/keybindings/*
# gate-watch: src/native-ts/color-diff/index.ts src/screens/REPL.tsx src/screens/ResumeConversation.tsx
# gate-watch: src/services/agents/* src/services/api/errors.ts src/services/api/usage.ts
# gate-watch: src/services/capFailover.ts src/services/concourse/concourseSnapshot.ts
# gate-watch: src/services/concourse/managerMode.ts src/services/engine-connector/daemonConnector.ts
# gate-watch: src/services/mockRateLimits.ts src/services/providers/deepseek/deepseekCallModel.ts
# gate-watch: src/services/providers/deepseek/deepseekLogin.ts src/services/providers/gemini/geminiAccounts.ts
# gate-watch: src/services/providers/huggingface/huggingfaceLogin.ts
# gate-watch: src/services/providers/moonshot/moonshotLogin.ts src/services/providers/providerUsage.ts
# gate-watch: src/services/providers/routeLaw.ts src/services/providers/zai/zaiCallModel.ts
# gate-watch: src/services/saturn/whenSpelling.ts src/services/switchboard/hopIntoSession.ts
# gate-watch: src/state/store.ts src/substrate/flagRegistry.ts src/substrate/splashHandover.ts
# gate-watch: src/tools/AgentTool/* src/tools/FileEditTool/FileEditTool.ts src/tools/FileEditTool/UI.tsx
# gate-watch: src/tools/FileReadTool/UI.tsx src/tools/FileWriteTool/UI.tsx
# gate-watch: src/tools/WorkshopTool/WorkshopCellCard.tsx
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss rc=%s\n' "$p" "$(( SECONDS - $2 ))" "${3:?proof exit code required}"; }

cd "$(dirname "$0")/../.." || exit 1
BUN="${BUN:-$HOME/.bun/bin/bun}"
here="scripts/ui-pure-2"

fail=0
while IFS= read -r name; do
  case "$name" in (''|'#'*) continue ;; esac
  f="scripts/ui/$name"
  if [ ! -e "$f" ]; then
    echo "❌ ui-pure-2: member '$name' has no file at $f — a stale member row is a red, never a silent skip"
    fail=1
    continue
  fi
  echo "▶ $f"
  __t=$SECONDS; __rc=0; if ! { "$BUN" run "$f"; __rc=$?; [ "$__rc" -eq 0 ]; }; then fail=1; fi; prover_mark "$f" "$__t" "$__rc"
  echo
done < "$here/members.txt"

if [ "$fail" -eq 0 ]; then echo "✅ UI-PURE-2 SUITE GREEN"; else echo "❌ UI-PURE-2 SUITE RED"; fi
exit "$fail"
