#!/usr/bin/env bash
# gate-class: pty
# gate-watch: src/ink/hooks/** src/ink/components/MotionParkContext.ts src/components/FullscreenLayout.tsx src/components/mercury-ui/components.tsx src/utils/cockpit/presenceLive.ts src/hooks/useArrowKeyHistory.tsx src/components/PromptInput/** assets/splash/**
# scripts/motion/run-all.sh — the motion proof suite.
# Auto-joins the pooled green gate via
# the scripts/*/run-all.sh glob.
#
# R1 — the Up-recall cursor law (end for one-visual-row recalls, start for
#      multi-row; the walk grammar survives both).
# R2 — invisible surfaces do no animation work (MotionParkContext under a
#      claims-modal + the presence tail's output-edge dedupe).
# R3 — the boot splash's one-scene motion laws (hero permanence, no blank
#      frame, settle continuity, cadence, resize reseat, reduced motion,
#      fill balance) — prove-splash-choreography over the splash-reel
#      capture substrate.
set -uo pipefail
# One wall-seconds line per prover — the pool engine reads exactly this shape.
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss\n' "$p" "$(( SECONDS - $2 ))"; }

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fail=0
echo "── motion proofs ──"
for f in "$here"/prove-*.ts; do
  [ -e "$f" ] || continue
  __t=$SECONDS; "${BUN:-$HOME/.bun/bin/bun}" run "$f" || fail=1; prover_mark "$f" "$__t"
done
if [[ "$fail" == "0" ]]; then echo "✅ MOTION SUITE GREEN"; exit 0; else
  echo "❌ MOTION SUITE RED"; exit 1; fi
