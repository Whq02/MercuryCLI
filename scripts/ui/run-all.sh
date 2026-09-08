#!/usr/bin/env bash
# gate-class: pty
# gate-watch: scripts/ui/render-tui.ts scripts/ui/vshot.py src/bootstrap/state*
# gate-watch: src/commands/appearance/index* src/commands/health/HealthCertificate*
# gate-watch: src/commands/run/runInspectorModel*
# gate-watch: src/commands/team/index* src/components/** src/context/overlayContext*
# gate-watch: src/context/overlayStack* src/daemon/** src/hooks/useLayoutTier* src/hooks/useCwdState* src/hooks/useFocusedWorkspaceCwd* src/ink/**
# gate-watch: src/keybindings/KeybindingProviderSetup* src/services/claudeAiLimits*
# gate-watch: src/utils/ripgrep.ts src/hooks/fileSuggestions.ts
# gate-watch: src/services/rateLimitMessages* src/services/run/** src/state/AppState*
# gate-watch: src/state/AppStateStore* src/substrate/bootNotes* src/tools/BriefTool/UI*
# gate-watch: src/types/logs* src/utils/**
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss rc=%s\n' "$p" "$(( SECONDS - $2 ))" "${3:?proof exit code required}"; }

cd "$(dirname "$0")/../.." || exit 1
BUN="${BUN:-$HOME/.bun/bin/bun}"
fail=0
claimed=$(cat scripts/ui-*/members.txt 2>/dev/null | grep -v '^#' | grep -v '^$')
dupes=$(printf '%s\n' "$claimed" | sort | uniq -d)
if [ -n "$dupes" ]; then
  echo "❌ ui: prover(s) named by TWO sibling member lists (a double run across shards):"
  printf '%s\n' "$dupes" | sed 's/^/    /'
  fail=1
fi
globs=(scripts/ui/prove-*.ts)
[ "${UI_RENDER:-0}" = "1" ] && globs+=(scripts/ui/render-*.ts scripts/ui/render-*.tsx)
for f in "${globs[@]}"; do
  [ -e "$f" ] || continue
  if printf '%s\n' "$claimed" | grep -qx "$(basename "$f")"; then continue; fi
  echo "▶ $f"
  __t=$SECONDS; __rc=0; if ! { "$BUN" run "$f"; __rc=$?; [ "$__rc" -eq 0 ]; }; then fail=1; fi; prover_mark "$f" "$__t" "$__rc"
  echo
done
if [ "$fail" -eq 0 ]; then echo "✅ UI SUITE GREEN"; else echo "❌ UI SUITE RED"; fi
exit "$fail"
