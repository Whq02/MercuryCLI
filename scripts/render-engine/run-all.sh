#!/bin/bash
# gate-class: pty
# ============================================================================
#  scripts/render-engine/run-all.sh — the render engine's law suite
#  (the flag-gated NEW painter: MERCURY_RENDER_ENGINE).
#
#  E1/E2 — settlement is an application decision; settled rows are written
#          once (prove-ledger-law).
#  E10  — the transcript is a flat projection; the dialect seam folds wire
#          re-presentations onto the record (prove-projection-flat), and the
#          doubled-reply class dies at the seam (prove-doubles-seed).
#  E4   — one writer, whole units, closed vocabulary (prove-door-law), with
#          synchronized-output brackets probed once and never left open
#          (prove-sync-bracket).
#  E5/E6 — scheduling follows cost; never compose for a choked terminal
#          (prove-scheduler-cost, prove-backpressure).
#  E7   — resize is a storm with one settled end (prove-resize-settle).
#  E8   — transient surfaces never touch history (prove-overlay-law).
#  E3   — the live tail is bounded and complete (prove-tail-bound).
#  E11  — time does not degrade the engine (prove-time-flat); the settle
#          swap forces no synchronous commit (prove-settle-no-sync-flush —
#          a synchronous flush there orphaned row subtrees without their
#          cleanup, retaining 6.4× the fibers).
#  spec02 — the stable-prefix discipline for streamed bodies
#          (prove-stable-prefix).
#  flag — registered, opt-in, structurally dormant while off
#          (prove-flag-dormant).
#  B2   — the junk-bytes smoke: the demo surface on a slow-drain pty parses
#          byte-for-byte clean (prove-junk-smoke; the 30-minute acceptance
#          recording is the same drive at duration).
# ============================================================================
set -uo pipefail
# One wall-seconds line per prover — the pool engine reads exactly this shape.
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss\n' "$p" "$(( SECONDS - $2 ))"; }

cd "$(dirname "$0")/../.." || exit 1

BUN="${BUN:-$HOME/.bun/bin/bun}"
fail=0

run() {
  echo "── $1"
  local __t=$SECONDS
  if ! "$BUN" run "$1"; then
    fail=1
  fi
  prover_mark "$1" "$__t"
}

run scripts/render-engine/prove-ledger-law.ts
run scripts/render-engine/prove-projection-flat.ts
run scripts/render-engine/prove-doubles-seed.ts
run scripts/render-engine/prove-door-law.ts
run scripts/render-engine/prove-sync-bracket.ts
run scripts/render-engine/prove-scheduler-cost.ts
run scripts/render-engine/prove-backpressure.ts
run scripts/render-engine/prove-resize-settle.ts
run scripts/render-engine/prove-overlay-law.ts
run scripts/render-engine/prove-tail-bound.ts
run scripts/render-engine/prove-time-flat.ts
run scripts/render-engine/prove-settle-no-sync-flush.ts
run scripts/render-engine/prove-stable-prefix.ts
run scripts/render-engine/prove-flag-dormant.ts
run scripts/render-engine/prove-junk-smoke.ts

if [ "$fail" -ne 0 ]; then
  echo "render-engine: RED"
  exit 1
fi
echo "render-engine: GREEN"
