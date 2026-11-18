#!/usr/bin/env bash
# gate-class: pure
# gate-watch: scripts/ui/**
# gate-watch: src/commands/run/runInspectorModel*
# gate-watch: src/commands/crew/index* src/context/overlayContext*
# gate-watch: src/daemon/** src/hooks/useCwdState* src/hooks/useFocusedWorkspaceCwd*
# gate-watch: src/services/anthropicLimits*
# gate-watch: src/utils/ripgrep.ts src/hooks/fileSuggestions.ts
# gate-watch: src/services/rateLimitMessages* src/services/run/**
# gate-watch: src/substrate/bootNotes*
# gate-watch: src/types/logs* src/utils/**
# gate-watch: scripts/lib/*
# gate-watch: src/*
# gate-watch: src/keybindings/*
# gate-watch: src/native-ts/color-diff/index.ts
# gate-watch: src/services/agents/*
# gate-watch: src/tools/AgentTool/* src/tools/FileEditTool/UI.tsx
# gate-watch: src/tools/FileWriteTool/UI.tsx
# gate-watch: src/services/engine-connector/types.ts
# gate-watch: src/screens/chat/*
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
