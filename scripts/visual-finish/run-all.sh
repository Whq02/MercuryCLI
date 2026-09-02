#!/usr/bin/env bash
# gate-class: pty
# gate-watch: scripts/visual-finish/**
# gate-watch: assets/splash/** src/components/mercury-ui/** src/components/mercuryPalette.ts
# gate-watch: src/utils/mercuryTokens.ts src/ink/colorize.ts src/ink/frame-writer.ts
# gate-watch: src/components/MercuryHome.tsx
# ============================================================================
#  scripts/visual-finish/run-all.sh —.
#
#  The later visual-finish: one continuous focal
#  material across every identity moment (Wordmark, BigWordmark, splash word,
#  splash selected label), complete capability honesty on the splash, bounded
#  same-class repair (roles/glyphs/state/motion/interaction censuses), and
#  the frame-writer OSC 8 link-fidelity fix.
#
#  Two lanes:
#    · standing proofs (prove-*.ts) — must pass, always;
# · the EXPECT-RED lane (repro-*.ts) — with the acceptance record as the
#      single status truth: a reproducer whose named rows are ALL met must
#      exit 0; one with any unmet row must exit 3 (CHECKS_FAILED_EXIT —
#      "still reproduces"); any other exit means the reproducer rotted
#      (import death, lost fixture) and fails the suite either way.
#
#  Auto-joins scripts/run-all-suites.sh via its scripts/*/run-all.sh glob.
# ============================================================================
set -uo pipefail
# One wall-seconds line per prover — the pool engine reads exactly this shape.
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss\n' "$p" "$(( SECONDS - $2 ))"; }

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
bun="${BUN:-$HOME/.bun/bin/bun}"
fail=0

echo "############################################################"
echo "# visual-finish — the visual-finish lane"
echo "############################################################"

for proof in "$here"/prove-*.ts; do
  [ -e "$proof" ] || continue
  echo
  echo "── $(basename "$proof") ──"
  __t=$SECONDS; (cd "$repo" && "$bun" run "$proof") || fail=1; prover_mark "$proof" "$__t"
done

echo
echo "── prove-link-journey.py ──"
__t=$SECONDS; (cd "$repo" && /usr/bin/python3 "$here/prove-link-journey.py") || fail=1; prover_mark "$here/prove-link-journey.py" "$__t"

echo
echo "── prove-resize-return.py ──"
__t=$SECONDS; (cd "$repo" && /usr/bin/python3 "$here/prove-resize-return.py") || fail=1; prover_mark "$here/prove-resize-return.py" "$__t"

# Regression reproducers: each one re-runs a defect that is fixed and must
# exit 0; a non-zero exit means the defect is back (or the reproducer itself
# rotted), and either fails the suite.
for repro in "$here"/repro-*.ts; do
  [ -e "$repro" ] || continue
  echo
  echo "── $(basename "$repro") ──"
  __t=$SECONDS; (cd "$repo" && "$bun" run "$repro") || fail=1; prover_mark "$repro" "$__t"
done

echo
echo "############################################################"
if [ "$fail" = "0" ]; then echo "# ✅ visual-finish PASS"; else echo "# ❌ visual-finish FAILED"; fi
echo "############################################################"
exit "$fail"
