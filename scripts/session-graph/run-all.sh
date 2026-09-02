#!/usr/bin/env bash
# gate-class: pty
# gate-watch: scripts/session-graph/**
# gate-watch: src/services/attention/** src/services/attention/relations.ts
# gate-watch: src/services/workbench/** src/services/acp/** src/input-core/composer-document.ts
# gate-watch: src/utils/artifacts/** src/utils/sideQuestion.ts src/utils/tabula/minerva.ts
# ============================================================================
#  scripts/session-graph/run-all.sh —.
#
#  Two lanes:
#    · standing proofs (prove-*.ts) — must pass, always;
# · the EXPECT-RED lane (repro-*.ts) — with the acceptance record as the
#      single status truth: a reproducer whose named rows are ALL met must
#      exit 0; one with any unmet row must exit 3 (CHECKS_FAILED_EXIT —
#      "still reproduces"); any other exit means the reproducer rotted
#      (import death, lost fixture) and fails the suite either way.
#
#  A third OPT-IN lane (CONSTELLATION_CLOSE_ARC=1) runs the §8 close-arc
#  aggregates — run-journeys.ts (every prover re-executed as the journey
#  table with needle anti-vacuity) and run-sensitivity.ts (mechanism-removal
#  legs in a scratch worktree). Slow by design (worktree + full re-runs);
#  the default pool covers every underlying prover once, so the lane is for
#  close and audits, not the per-push gate.
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
echo "# session-graph — the living-crew lane"
echo "############################################################"

for proof in "$here"/prove-*.ts; do
  [ -e "$proof" ] || continue
  echo
  echo "── $(basename "$proof") ──"
  __t=$SECONDS; (cd "$repo" && "$bun" run "$proof") || fail=1; prover_mark "$proof" "$__t"
done

# Regression reproducers: each one re-runs a defect that is fixed and must
# exit 0; a non-zero exit means the defect is back (or the reproducer itself
# rotted), and either fails the suite.
for repro in "$here"/repro-*.ts; do
  [ -e "$repro" ] || continue
  echo
  echo "── $(basename "$repro") ──"
  __t=$SECONDS; (cd "$repo" && "$bun" run "$repro") || fail=1; prover_mark "$repro" "$__t"
done

if [ "${CONSTELLATION_CLOSE_ARC:-0}" = "1" ]; then
  for runner in "$here"/run-journeys.ts "$here"/run-sensitivity.ts; do
    echo
    echo "── $(basename "$runner") (close-arc lane) ──"
    (cd "$repo" && "$bun" run "$runner") || fail=1
  done
fi

echo
echo "############################################################"
if [ "$fail" = "0" ]; then echo "# ✅ session-graph PASS"; else echo "# ❌ session-graph FAILED"; fi
echo "############################################################"
exit "$fail"
