#!/usr/bin/env bash
# gate-class: pty
# gate-watch: src/ink/**
# gate-watch: src/keybindings/**
# gate-watch: src/components/CustomSelect/** src/components/permissions/AskUserQuestionPermissionRequest/**
# gate-watch: scripts/lib/*
# gate-watch: src/substrate/flagRegistry.ts
# gate-watch: src/* src/components/* src/components/PromptInput/* src/components/mercury-ui/*
# gate-watch: src/hooks/*
# gate-watch: src/utils/*
# gate-watch: docs/SESSIONS.md src/commands/copy/copy.ts src/commands/copy/index.ts src/components/HelpV2/ShortcutsTab.tsx src/components/Settings/Config.tsx src/utils/config/schema.ts src/utils/messages/normalize.ts
# gate-watch: src/screens/chat/*
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
