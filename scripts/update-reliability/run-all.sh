#!/usr/bin/env bash
# gate-class: pure
# gate-watch: scripts/update-reliability/**
# gate-watch: src/services/privateChannel/** scripts/release/** scripts/updater/**
# gate-watch: .github/workflows/private-release.yml
# ============================================================================
#  scripts/update-reliability/run-all.sh — MERCURY UPDATE-RELIABILITY's
#
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
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
bun="${BUN:-$HOME/.bun/bin/bun}"
fail=0

echo "############################################################"
echo "# UPDATE-RELIABILITY — the private-channel field-fix lane"
echo "############################################################"

for proof in "$here"/prove-*.ts; do
  [ -e "$proof" ] || continue
  echo
  echo "── $(basename "$proof") ──"
  (cd "$repo" && "$bun" run "$proof") || fail=1
done

# Regression reproducers: each one re-runs a defect that is fixed and must
# exit 0; a non-zero exit means the defect is back (or the reproducer itself
# rotted), and either fails the suite.
for repro in "$here"/repro-*.ts; do
  [ -e "$repro" ] || continue
  echo
  echo "── $(basename "$repro") ──"
  (cd "$repo" && "$bun" run "$repro") || fail=1
done

echo
echo "############################################################"
if [ "$fail" = "0" ]; then echo "# ✅ UPDATE-RELIABILITY PASS"; else echo "# ❌ UPDATE-RELIABILITY FAILED"; fi
echo "############################################################"
exit "$fail"
