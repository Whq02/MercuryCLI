#!/usr/bin/env bash
# gate-class: pty
# gate-watch: scripts/interview/**
# gate-watch: src/tools/AskUserQuestionTool/** src/components/permissions/AskUserQuestionPermissionRequest/**
# gate-watch: src/utils/planModeV2.ts src/utils/messages/attachmentText.ts src/tools/EnterPlanModeTool/**
# ============================================================================
#  scripts/interview/run-all.sh — MERCURY INTERVIEW's.
#
#  Two lanes:
#    · standing proofs (prove-*.ts) — must pass, always;
# · the EXPECT-RED lane (repro-*.ts) — per the runner doctrine, with
#      the acceptance record as the single status truth: a reproducer whose
#      named rows are ALL met must exit 0; one with any unmet row must exit 3
#      (CHECKS_FAILED_EXIT — "still reproduces"); any other exit means the
#      reproducer rotted (import death, lost fixture) and fails the suite
#      either way. Flipping a row to met therefore REQUIRES the fix, and a
#      parked red can neither rot nor silently pass.
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
echo "# INTERVIEW — the evidence-first design-conversation lane"
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

echo
echo "############################################################"
if [ "$fail" = "0" ]; then echo "# ✅ INTERVIEW PASS"; else echo "# ❌ INTERVIEW FAILED"; fi
echo "############################################################"
exit "$fail"
