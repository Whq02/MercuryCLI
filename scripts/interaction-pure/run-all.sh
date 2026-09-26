#!/usr/bin/env bash
# gate-class: pure
# gate-watch: scripts/interaction/** scripts/interaction-pure/**
# gate-watch: src/components/design-system/ThemeProvider* src/components/mercuryPalette*
# gate-watch: src/components/mercury-ui/InteractiveRow* src/components/mercury-ui/NavigablePanes*
# gate-watch: src/ink/** src/state/AppState* src/utils/inputRange* src/utils/mercuryTokens*
# gate-watch: src/components/MessageSelector* src/keybindings/**
# gate-watch: src/components/CustomSelect/** src/components/permissions/AskUserQuestionPermissionRequest/**
# gate-watch: src/commands/appearance/appearance.tsx src/commands/caching/caching.tsx
# gate-watch: src/commands/console/console.tsx src/commands/copy/copy.tsx src/commands/effort/EffortSlider.tsx
# gate-watch: src/commands/health/HealthCertificate.tsx src/commands/home/home.tsx src/commands/run/run.tsx
# gate-watch: src/components/* src/components/PromptInput/* src/components/Settings/*
# gate-watch: src/components/agents/studio/AgentStudio.tsx src/components/agents/studio/StudioEditor.tsx
# gate-watch: src/components/concourse/* src/components/design-system/ThemedBox.tsx
# gate-watch: src/components/diff/DiffFileList.tsx src/components/extensions/* src/components/mcp/*
# gate-watch: src/components/memory/MemoryCentreView.tsx src/components/mercury-ui/*
# gate-watch: src/components/mercury-ui/parity/* src/components/mercury-ui/screens/*
# gate-watch: src/components/messages/SystemTextMessage.tsx
# gate-watch: src/components/permissions/rules/RecentDenialsTab.tsx
# gate-watch: src/components/prompts-panel/PromptsPanel.tsx src/components/samples/SamplesListView.tsx
# gate-watch: src/components/skills/SessionSkillsDial.tsx src/components/tasks/*
# gate-watch: src/components/teams/TeamsDialog.tsx src/hooks/* src/main.tsx src/screens/REPL.tsx
# gate-watch: src/screens/ResumeConversation.tsx
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss rc=%s\n' "$p" "$(( SECONDS - $2 ))" "${3:?proof exit code required}"; }

cd "$(dirname "$0")/../.." || exit 1
BUN="${BUN:-$HOME/.bun/bin/bun}"
here="scripts/interaction-pure"

fail=0
while IFS= read -r name; do
  case "$name" in (''|'#'*) continue ;; esac
  f="scripts/interaction/$name"
  if [ ! -e "$f" ]; then
    echo "❌ interaction-pure: member '$name' has no file at $f — a stale member row is a red, never a silent skip"
    fail=1
    continue
  fi
  echo "▶ $f"
  __t=$SECONDS; __rc=0; if ! { "$BUN" run "$f"; __rc=$?; [ "$__rc" -eq 0 ]; }; then fail=1; fi; prover_mark "$f" "$__t" "$__rc"
  echo
done < "$here/members.txt"

if [ "$fail" -eq 0 ]; then echo "✅ INTERACTION-PURE SUITE GREEN"; else echo "❌ INTERACTION-PURE SUITE RED"; fi
exit "$fail"
