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
# ============================================================================
#  scripts/ui/run-all.sh — the UI / render-logic proof suite.
#  Home for proofs of the Mercury design-system surfaces whose CORRECTNESS is
#  pure logic (timing, gates, token math) — render-verify (vshot.py) still covers
#  the actual pixels; these lock the logic so a 150ms blink frame need not be raced
#  in a live PTY. Globs prove-*.ts like every other domain suite.
#  The interaction-finish program's HEAVY real-binary PTY proofs live in the
#  sister suites scripts/journey/, scripts/diffws/, scripts/interaction/ (split
# this suite hit the 900s watchdog with them inboard).
#
#  THE RULED SPLIT: the prove-*.ts estate outgrew any one CI
#  ceiling, so the sibling sub-suites scripts/ui-2..-N each run an explicit
#  members.txt slice of scripts/ui/prove-*.ts, and THIS runner is the
#  COMPLEMENT — every prover NOT named by a sibling list runs here, so a newly
#  landed prove-*.ts joins the gate automatically (the suite-membership law:
#  no orphan provers) and membership moves only by editing member lists. This
#  runner is also the membership-law keeper: a name listed by TWO sibling
#  lists (a double run across shards) is a red here. The render-*.ts/.tsx
#  pixel proofs stay THIS runner's UI_RENDER=1 opt-in arm.
#
#  render-*.ts are the heavy render-verify proofs (each boots the built binary in a
#  pyte PTY × N cells × ~16s) — they JOIN this suite but stay OPT-IN behind
#  UI_RENDER=1 so the default green-gate (advertised ~30s) doesn't pay the minutes
#  of PTY boots. Run the pixels with:  UI_RENDER=1 bash scripts/ui/run-all.sh
# ============================================================================
set -uo pipefail
# One wall-seconds line per prover — the pool engine reads exactly this shape.
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss\n' "$p" "$(( SECONDS - $2 ))"; }

cd "$(dirname "$0")/../.." || exit 1
BUN="${BUN:-$HOME/.bun/bin/bun}"
fail=0
# Pure-logic proofs always run; the slow render-verify joins only under UI_RENDER=1.
# BOTH extensions: a bare `render-*.ts` glob silently orphaned every .tsx render
# proof for weeks (6 files, incl. the a11y one — found; bash globs
# don't ?-match, so *.ts never covers *.tsx).
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
  __t=$SECONDS; if ! "$BUN" run "$f"; then fail=1; fi; prover_mark "$f" "$__t"
  echo
done
if [ "$fail" -eq 0 ]; then echo "✅ UI SUITE GREEN"; else echo "❌ UI SUITE RED"; fi
exit "$fail"
