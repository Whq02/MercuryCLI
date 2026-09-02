#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/tools/LaunchFleetTool/prompt*
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
