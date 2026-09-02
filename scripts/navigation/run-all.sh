#!/usr/bin/env bash
# gate-class: cpu
# gate-watch: scripts/streaming/ptydrive.py scripts/ui/render-tui.ts scripts/ui/vshot.py
# gate-watch: src/components/mercury-ui/** src/context/overlayStack* src/ink/events/input-event*
# gate-watch: src/ink/input/input-decoder* src/ink/stringWidth*
# gate-watch: src/components/Mercury*.tsx src/components/ScrollKeybindingHandler.tsx src/components/LogSelector.tsx
# gate-watch: src/components/CritterSelect.tsx src/components/FleetMonitor.tsx src/components/BaseTextInput.tsx src/components/FullscreenLayout.tsx
# gate-watch: src/components/tabula/MinervaRoom.tsx src/components/prompts-panel/PromptsPanel.tsx src/components/tasks/RunDetailPane.tsx src/components/teams/TeamsDialog.tsx
# gate-watch: src/components/CustomSelect/use-select-navigation.ts src/components/permissions/AskUserQuestionPermissionRequest/QuestionView.tsx
# gate-watch: src/commands/console/console.tsx src/commands/effort/effort.tsx src/hooks/useTextInput.ts
# gate-watch: src/components/concourse/ConcourseRoute.tsx src/ink/session/capabilities.ts src/ink/root/screen-session.ts
# ============================================================================
# scripts/navigation/run-all.sh — the proof suite (pooled-gate
# member). PROVERS ONLY: the measurement instruments in this directory
# (fixture1k.ts · arena.ts · measure-baseline.ts · ptydrive.py) are run
# by hand for before/after receipts and are
# deliberately NOT gate legs — a minutes-long PTY campaign has no place in
# the green gate.
# ============================================================================
set -uo pipefail
# One wall-seconds line per prover — the pool engine reads exactly this shape.
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss\n' "$p" "$(( SECONDS - $2 ))"; }

cd "$(dirname "$0")/../.." || exit 1

BUN="${BUN:-$HOME/.bun/bin/bun}"
failures=0

run() {
  local name="$1"; shift
  echo "── $name"
  local __t=$SECONDS last
  for last; do :; done
  if ! "$@"; then
    echo "❌ $name FAILED"
    failures=$((failures + 1))
  fi
  prover_mark "$last" "$__t"
}

run "nav-semantics" "$BUN" run scripts/navigation/prove-nav-semantics.ts
run "section-crossing" "$BUN" run scripts/navigation/prove-section-crossing.ts
run "focus-routing" "$BUN" run scripts/navigation/prove-focus-routing.ts
run "geometry" "$BUN" run scripts/navigation/prove-geometry.ts
run "input-compat" "$BUN" run scripts/navigation/prove-input-compat.ts
run "size-matrix" "$BUN" run scripts/navigation/prove-size-matrix.ts
run "grapheme-corpus" "$BUN" run scripts/navigation/prove-grapheme-corpus.ts

if [ "$failures" -gt 0 ]; then
  echo "❌ navigation suite: $failures prover(s) RED"
  exit 1
fi
echo "✅ navigation suite GREEN"
