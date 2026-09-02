#!/usr/bin/env bash
# gate-class: pty
# gate-watch: scripts/prompts-panel/** scripts/ui/vshot.py scripts/ui/renderScenarios.ts
# gate-watch: src/components/prompts-panel/** src/commands/workbench/**
# gate-watch: src/utils/savedPrompts/** src/utils/tabula/** src/components/tabula/** src/commands/tabula/**
# gate-watch: src/components/mercury-ui/NavigablePanes.tsx src/hooks/useSessionConnector.ts
# ============================================================================
#  scripts/prompts-panel/run-all.sh — THE PROMPTS PANEL (the WORK panel
#  retired in place).
#
#    prove-prompt-rows          — the read-only projection over the records
#                                 (prompt rows · crew threads · the limits
#                                 line) + the reads-only census
#    prove-saved-prompts-store  — the per-project saved-prompts JSON: round
#                                 trip · durable publish · the refinement
#                                 law · a fresh-process restart read
#    prove-minerva-room         — Minerva's room against a loopback wire:
#                                 sees-never-acts-uninvited · beside-never-
#                                 over · never sends · unset ⇒ zero spend
#    prove-panel-captures       — the BUILT bundle in a PTY at 120x40 and
#                                 100x30: every sheet line's screen (needs
#                                 dist at HEAD — `bun run build.ts`)
#    prove-hop-follows-focus    — sheet line 2 on the REAL product: two
#                                 daemon-carried sessions on a fixture API,
#                                 enter one, open the panel, hop, open it
#                                 again — the roll follows the focused chat
#
#  Auto-joins scripts/run-all-suites.sh via the glob.
# ============================================================================
set -uo pipefail
# One wall-seconds line per prover — the pool engine reads exactly this shape.
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss\n' "$p" "$(( SECONDS - $2 ))"; }

here="$(cd "$(dirname "$0")" && pwd)"
BUN="${BUN:-$HOME/.bun/bin/bun}"
cd "$here/../.."
fail=0
echo "############################################################"
echo "# PROMPTS PANEL — records · saved prompts · Minerva's room"
echo "############################################################"
for f in prove-prompt-rows prove-saved-prompts-store prove-minerva-room prove-panel-captures prove-hop-follows-focus prove-detail-footer-honesty; do
  echo "── scripts/prompts-panel/$f.ts"
  __t=$SECONDS; "$BUN" run "$here/$f.ts" || fail=1; prover_mark "$here/$f.ts" "$__t"
done
echo "############################################################"
if [ "$fail" = "0" ]; then echo "# ✅ PROMPTS PANEL PASS"; else echo "# ❌ PROMPTS PANEL FAILED"; fi
echo "############################################################"
exit "$fail"
