#!/bin/bash
# gate-class: pty
# ============================================================================
#  scripts/render-migration/run-all.sh — the migration/parity lane's suite
#  (the cockpit on the engine, behind MERCURY_RENDER_ENGINE — sheet lane 2).
#
#  fold  — the dialect-seam fold's laws: durable coordinates, attempt-blind
#          refold, retraction, run boundary (prove-record-fold).
#  ledger — the settled-prefix ledger under the pane: turn-lag stability,
#          ordered batches, flatness drops, agreement divergence, width
#          epochs (prove-cockpit-ledger).
#  gates — the ink scheduler under the engine's gates: flag-off identity,
#          E6 choke, E5 adaptive floor, the keystroke lane
#          (prove-scheduler-gates).
#  door  — the second write path folds into the ONE door: unbound identity,
#          bound FIFO, whole units under EAGAIN, drain truth, teardown flush
#          (prove-door-fold).
#  B1    — the doubled-replies test on the PRODUCT path: the growth
#          curve flat at 1 per settled row on all three dialects through the
#          REAL runtime + REAL REPL seam + REAL projection; the
#          re-presentation control (uuid law appends ⇒ the fold refolds);
#          the settled-row ledger freezing across the session
#          (prove-doubles-growth-curve; 40-turn evidence runs are the same
#          drive at duration).
#  live  — the engine-mounted cockpit in a real PTY, tripwires armed: two
#          turns settle, the cockpit doubles census on the pyte grid, zero
#          torn escapes in the raw stream (prove-engine-cockpit-smoke).
#  parity — LOOK PARITY: settled cockpit frames cell-
#          identical engine ON vs OFF on the capture matrix (120x40 · 100x30
#          × dark · light), glyphs and styles, the baseline masks only
#          (prove-look-parity).
#  numbers — the measured numbers (paint gaps p99, resize settle,
#          keystroke echo, first glyph, send start) live in
#          measure-numbers.ts — an evidence drive, not pooled here.
#
#  The built artifact is rebuilt ONCE at the top (the stale-dist guard);
#  the pty provers then run against that build.
# ============================================================================
set -uo pipefail
# One wall-seconds line per prover — the pool engine reads exactly this shape.
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss\n' "$p" "$(( SECONDS - $2 ))"; }

cd "$(dirname "$0")/../.."

BUN="${BUN:-$HOME/.bun/bin/bun}"
fail=0

run() {
  echo "── $*"
  local __t=$SECONDS
  if ! "$BUN" run "$@"; then
    fail=1
  fi
  prover_mark "$1" "$__t"
}

echo "── bun run build.ts (the stale-dist guard: one build, every pty prover below runs against it)"
__b=$SECONDS
if ! "$BUN" run build.ts > /dev/null 2>&1; then
  echo "render-migration: build failed"
  exit 1
fi
printf '── build.ts  %ss\n' "$(( SECONDS - __b ))"

run scripts/render-migration/prove-record-fold.ts
run scripts/render-migration/prove-cockpit-ledger.ts
run scripts/render-migration/prove-scheduler-gates.ts
run scripts/render-migration/prove-door-fold.ts
run scripts/render-migration/prove-doubles-growth-curve.ts --turns 18
run scripts/render-migration/prove-engine-cockpit-smoke.ts --skip-build
run scripts/render-migration/prove-look-parity.ts --skip-build

if [ "$fail" -ne 0 ]; then
  echo "render-migration: RED"
  exit 1
fi
echo "render-migration: GREEN"
