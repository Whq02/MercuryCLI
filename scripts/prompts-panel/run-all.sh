#!/usr/bin/env bash
# gate-class: pty
# gate-watch: scripts/prompts-panel/** scripts/ui/vshot.py scripts/ui/renderScenarios.ts
# gate-watch: src/components/prompts-panel/** src/commands/workbench/**
# gate-watch: src/utils/savedPrompts/** src/utils/tabula/** src/components/tabula/** src/commands/tabula/**
# gate-watch: src/components/mercury-ui/NavigablePanes.tsx src/hooks/useSessionConnector.ts
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss rc=%s\n' "$p" "$(( SECONDS - $2 ))" "${3:?proof exit code required}"; }

here="$(cd "$(dirname "$0")" && pwd)"
BUN="${BUN:-$HOME/.bun/bin/bun}"
cd "$here/../.." || exit 1
fail=0
echo "############################################################"
echo "# PROMPTS PANEL — records · saved prompts · Minerva's room"
echo "############################################################"
for f in prove-prompt-rows prove-saved-prompts-store prove-minerva-room prove-panel-captures prove-hop-follows-focus prove-detail-footer-honesty; do
  echo "── scripts/prompts-panel/$f.ts"
  __t=$SECONDS; __rc=0; "$BUN" run "$here/$f.ts" || { __rc=$?; fail=1; }; prover_mark "$here/$f.ts" "$__t" "$__rc"
done
echo "############################################################"
if [ "$fail" = "0" ]; then echo "# ✅ PROMPTS PANEL PASS"; else echo "# ❌ PROMPTS PANEL FAILED"; fi
echo "############################################################"
exit "$fail"
