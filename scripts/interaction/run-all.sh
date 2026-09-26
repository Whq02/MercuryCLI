#!/usr/bin/env bash
# gate-class: pty
# gate-watch: src/components/design-system/ThemeProvider* src/components/mercuryPalette*
# gate-watch: src/components/mercury-ui/InteractiveRow* src/components/mercury-ui/NavigablePanes*
# gate-watch: src/ink/** src/state/AppState* src/utils/inputRange* src/utils/mercuryTokens*
# gate-watch: src/components/MessageSelector* src/keybindings/**
# gate-watch: src/components/CustomSelect/** src/components/permissions/AskUserQuestionPermissionRequest/**
# gate-watch: scripts/lib/* scripts/streaming/artifactArena.ts scripts/ui/renderScenarios.ts
# gate-watch: scripts/ui/vshot.py
# gate-watch: src/* src/components/* src/components/PromptInput/* src/components/mercury-ui/*
# gate-watch: src/components/messages/AssistantToolUseMessage.tsx src/components/tasks/CompactWorkSummary.tsx
# gate-watch: src/components/tasks/useFocusedWork.ts src/entrypoints/init.ts src/hooks/*
# gate-watch: src/input-core/pending-input.ts src/screens/REPL.tsx src/tools/AgentTool/AgentTool.tsx
# gate-watch: src/tools/AgentTool/UI.tsx src/tools/GlobTool/GlobTool.ts src/tools/GlobTool/UI.tsx
# gate-watch: src/tools/GrepTool/GrepTool.ts src/tools/TaskOutputTool/TaskOutputTool.tsx src/utils/*
# gate-watch: src/utils/cockpit/inputSelectionBridge.ts
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss rc=%s\n' "$p" "$(( SECONDS - $2 ))" "${3:?proof exit code required}"; }

cd "$(dirname "$0")/../.." || exit 1
BUN="${BUN:-$HOME/.bun/bin/bun}"
fail=0
claimed=$(cat scripts/interaction-*/members.txt 2>/dev/null | grep -v '^#' | grep -v '^$')
dupes=$(printf '%s\n' "$claimed" | sort | uniq -d)
if [ -n "$dupes" ]; then
  echo "❌ interaction: prover(s) named by TWO sibling member lists (a double run across shards):"
  printf '%s\n' "$dupes" | sed 's/^/    /'
  fail=1
fi
for f in scripts/interaction/prove-*.ts; do
  [ -e "$f" ] || continue
  if printf '%s\n' "$claimed" | grep -qx "$(basename "$f")"; then continue; fi
  echo "▶ $f"
  __t=$SECONDS; __rc=0; if ! { "$BUN" run "$f"; __rc=$?; [ "$__rc" -eq 0 ]; }; then fail=1; fi; prover_mark "$f" "$__t" "$__rc"
  echo
done
if [ "$fail" -eq 0 ]; then echo "✅ INTERACTION SUITE GREEN"; else echo "❌ INTERACTION SUITE RED"; fi
exit "$fail"
