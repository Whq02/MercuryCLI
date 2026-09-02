#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/tools/LaunchFleetTool/prompt*
# ============================================================================
#  scripts/fleet/run-all.sh — LaunchFleet allocation-clause proof (change #15).
#
#  ATLAS (arXiv:2606.01667) "allocate, don't max out": fan width should track the
#  work's real independence/difficulty rather than a preset count. LaunchFleet's
#  tool description shipped with ZERO allocation prose (the only fan-out bias lived
#  in coordinatorMode.ts — deleted, machinery prune), so #15 ADDS that absent axis. This grep-assert
#  catches a regression that DELETES or WEAKENS the clause — it is a PRESENCE proof,
#  not a behavioral one (the only available guard for a prose-only tool description).
#
#  TWO arms (per the plan's both-arms rule):
#    (1) the allocation clause IS present (the real thing passes), AND
#    (2) the no-automatic-stop disclaimer IS present — the clause must NOT imply
#        convergence ends the mission (LaunchFleet's stop is the dependsOn DAG
#        completing). A clause that drops (2) is the planted-bad arm and reddens.
#
#  Auto-joins the green-gate via scripts/run-all-suites.sh (globs scripts/*/run-all.sh).
# ============================================================================
set -u
here="$(cd "$(dirname "$0")" && pwd)"
src="$here/../../src/tools/LaunchFleetTool/prompt.ts"
fail=0

echo "############################################################"
echo "# LaunchFleet — ATLAS allocation-clause proof (#15)"
echo "############################################################"

if [ ! -f "$src" ]; then
  echo "  [FAIL] target not found: $src"
  echo "############################################################"
  echo "# ❌ LAUNCHFLEET ALLOCATION-CLAUSE PROOF FAILED"
  echo "############################################################"
  exit 1
fi

# Arm 1 — the allocation axis is present (fan tracks independence/difficulty,
# not a preset count). Fixed strings (-F); each must be found.
check() {
  local label="$1" needle="$2"
  if grep -qF -- "$needle" "$src"; then
    echo "  [PASS] $label"
  else
    echo "  [FAIL] $label — missing: \"$needle\""
    fail=1
  fi
}

check "allocation axis: size to real independence/difficulty" \
  "Size the fan to the work's real independence and difficulty, not a preset count"
check "converge-before-widen + add only where evidence is thin/conflicting" \
  "let independent subtasks converge before you widen"
check "add subtasks only where evidence is thin or conflicting" \
  "add subtasks only where the evidence is thin or conflicting"

# Arm 2 — the clause must NOT imply convergence is an automatic stop: the
# dependsOn DAG completing is the stop. This disclaimer must travel WITH the
# clause; dropping it is the planted-bad regression.
check "no-automatic-stop disclaimer: stop is the dependsOn DAG completing" \
  "finishes when its dependsOn DAG completes, not on any convergence signal"

echo "############################################################"
if [ "$fail" = "0" ]; then
  echo "# ✅ LAUNCHFLEET ALLOCATION-CLAUSE PROOF PASS"
else
  echo "# ❌ LAUNCHFLEET ALLOCATION-CLAUSE PROOF FAILED"
fi
echo "############################################################"
exit "$fail"
