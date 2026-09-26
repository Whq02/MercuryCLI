#!/usr/bin/env bash
# gate-class: pure
# gate-watch: scripts/ui/** scripts/ui-pure-1/** src/bootstrap/state*
# gate-watch: src/commands/appearance/index* src/commands/health/HealthCertificate*
# gate-watch: src/commands/run/runInspectorModel*
# gate-watch: src/commands/team/index* src/components/** src/context/overlayContext*
# gate-watch: src/context/overlayStack* src/daemon/** src/hooks/useLayoutTier* src/hooks/useCwdState* src/hooks/useFocusedWorkspaceCwd* src/ink/**
# gate-watch: src/keybindings/KeybindingProviderSetup* src/services/claudeAiLimits*
# gate-watch: src/utils/ripgrep.ts src/hooks/fileSuggestions.ts
# gate-watch: src/services/rateLimitMessages* src/services/run/** src/state/AppState*
# gate-watch: src/state/AppStateStore* src/substrate/bootNotes* src/tools/BriefTool/UI*
# gate-watch: src/types/logs* src/utils/**
# gate-watch: assets/splash/mercury-splash.mjs assets/splash/splash-core.mjs
# gate-watch: scripts/cockpit-interaction/prove-action-graph.ts scripts/engine-durability/harness.ts
# gate-watch: scripts/ink-runtime/prove-viewport-clamp.ts scripts/lib/* scripts/ops/launcher-mercury.sh
# gate-watch: scripts/release/launcherTemplates.mjs scripts/search/lib/bundle-for-node.ts
# gate-watch: src/commands/config/config.tsx src/commands/context/context.tsx src/commands/export/export.tsx
# gate-watch: src/commands/feedback/index.ts src/commands/login/login.tsx
# gate-watch: src/commands/sessiontab/sessiontab.tsx src/commands/terminalSetup/terminalSetup.tsx
# gate-watch: src/context/* src/hooks/* src/ink.ts src/input-core/* src/interactiveHelpers.tsx
# gate-watch: src/keybindings/* src/native-ts/color-diff/index.ts src/screens/REPL.tsx
# gate-watch: src/screens/ResumeConversation.tsx src/services/api/*
# gate-watch: src/services/changeTransaction/changeSetCommit.ts src/services/concourse/managerMode.ts
# gate-watch: src/services/engine-connector/* src/services/ide/projectRunners.ts src/services/kitMenu/*
# gate-watch: src/services/lsp/serverCatalogue.ts src/services/mcp/* src/services/oauth/client.ts
# gate-watch: src/services/privateChannel/updateService.ts src/services/projectServices/serviceManager.ts
# gate-watch: src/services/providers/anthropic/streamCore.ts src/services/providers/deepseek/deepseekLogin.ts
# gate-watch: src/services/providers/gemini/geminiLogin.ts
# gate-watch: src/services/providers/huggingface/huggingfaceAccounts.ts
# gate-watch: src/services/providers/huggingface/huggingfaceLogin.ts
# gate-watch: src/services/providers/moonshot/moonshotLogin.ts src/services/providers/openai/openaiLogin.ts
# gate-watch: src/services/providers/openrouter/openrouterLogin.ts src/services/providers/patience.ts
# gate-watch: src/services/providers/zai/zaiLogin.ts src/services/switchboard/* src/state/store.ts
# gate-watch: src/substrate/* src/tools/BashTool/BashTool.tsx src/tools/BashTool/UI.tsx
# gate-watch: src/tools/PowerShellTool/PowerShellTool.tsx src/tools/PowerShellTool/UI.tsx
# gate-watch: src/tools/WorkshopTool/WorkshopCellCard.tsx src/tools/commandDisplay.ts src/vim/*
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss rc=%s\n' "$p" "$(( SECONDS - $2 ))" "${3:?proof exit code required}"; }

cd "$(dirname "$0")/../.." || exit 1
BUN="${BUN:-$HOME/.bun/bin/bun}"
here="scripts/ui-pure-1"

fail=0
while IFS= read -r name; do
  case "$name" in (''|'#'*) continue ;; esac
  f="scripts/ui/$name"
  if [ ! -e "$f" ]; then
    echo "❌ ui-pure-1: member '$name' has no file at $f — a stale member row is a red, never a silent skip"
    fail=1
    continue
  fi
  echo "▶ $f"
  __t=$SECONDS; __rc=0; if ! { "$BUN" run "$f"; __rc=$?; [ "$__rc" -eq 0 ]; }; then fail=1; fi; prover_mark "$f" "$__t" "$__rc"
  echo
done < "$here/members.txt"

if [ "$fail" -eq 0 ]; then echo "✅ UI-PURE-1 SUITE GREEN"; else echo "❌ UI-PURE-1 SUITE RED"; fi
exit "$fail"
