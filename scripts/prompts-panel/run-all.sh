#!/usr/bin/env bash
# gate-class: pty
# gate-watch: scripts/prompts-panel/** scripts/ui/vshot.py scripts/ui/renderScenarios.ts
# gate-watch: src/components/prompts-panel/** src/commands/workbench/**
# gate-watch: src/utils/savedPrompts/** src/utils/tabula/** src/components/tabula/** src/commands/tabula/**
# gate-watch: src/components/mercury-ui/NavigablePanes.tsx src/hooks/useSessionConnector.ts
set -uo pipefail
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss\n' "$p" "$(( SECONDS - $2 ))"; }

here="$(cd "$(dirname "$0")" && pwd)"
BUN="${BUN:-$HOME/.bun/bin/bun}"
cd "$here/../.."
fail=0
echo "############################################################"
echo "# PROMPTS PANEL — records · saved prompts · Minerva's room"
echo "############################################################"
for f in prove-prompt-rows prove-saved-prompts-store prove-minerva-room prove-panel-captures prove-hop-follows-focus; do
  echo "── scripts/prompts-panel/$f.ts"
  __t=$SECONDS; "$BUN" run "$here/$f.ts" || fail=1; prover_mark "$here/$f.ts" "$__t"
done
echo "############################################################"
if [ "$fail" = "0" ]; then echo "# ✅ PROMPTS PANEL PASS"; else echo "# ❌ PROMPTS PANEL FAILED"; fi
echo "############################################################"
exit "$fail"
