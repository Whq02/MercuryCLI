#!/usr/bin/env bash
# gate-class: cpu
# (re-classed: prove-c3-resize-stream boots dist — the cpu class by
#  definition; the rest of the suite stays pure logic.)
# gate-watch: scripts/attention/**
# gate-watch: src/services/attention/** src/services/workbench/** src/input-core/**
# gate-watch: src/utils/sideQuestion.ts src/services/acp/** src/components/tasks/**
# ============================================================================
#  scripts/attention/run-all.sh —.
#
#  Two lanes:
#    · standing proofs (prove-*.ts) — must pass, always;
# · the EXPECT-RED lane (repro-journey-*.ts) — restored per the runner
#      doctrine ("only for a defect whose fix is genuinely scheduled for a
#      later stage"), with the acceptance record as the single status truth:
#      a reproducer whose named rows are ALL met must exit 0; one with any
#      unmet row must exit 3 (CHECKS_FAILED_EXIT — "still reproduces"); any
#      other exit means the reproducer rotted (import death, lost fixture)
#      and fails the suite either way. Flipping a row to met therefore
#      REQUIRES the fix, and a parked red can neither rot nor silently pass.
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
echo "# attention — the operator command surface"
echo "############################################################"

# Provers named by a sibling member list (scripts/attention-*/members.txt) run in
# that sibling suite — the real-terminal drives — never here.
claimed=$(cat scripts/attention-*/members.txt 2>/dev/null | grep -v '^#' | grep -v '^$')

for proof in "$here"/prove-*.ts; do
  if printf '%s\n' "$claimed" | grep -qx "$(basename "$proof")"; then continue; fi
  echo
  echo "── $(basename "$proof") ──"
  __t=$SECONDS; (cd "$repo" && "$bun" run "$proof") || fail=1; prover_mark "$proof" "$__t"
done

# The MACHINE-GATED lane: a journey-*.ts may exit 3 to mean "this
# machine cannot run the journey — the gate is honoured, loudly". 0 = ran and
# passed; anything else is a real failure.
for journey in "$here"/journey-*.ts; do
  if printf '%s\n' "$claimed" | grep -qx "$(basename "$journey")"; then continue; fi
  [ -e "$journey" ] || continue
  echo
  echo "── $(basename "$journey") (machine-gated) ──"
  (cd "$repo" && "$bun" run "$journey")
  got=$?
  if [ "$got" = "3" ]; then
    echo "⏭  $(basename "$journey") SKIP — machine gate honoured"
  elif [ "$got" != "0" ]; then
    echo "❌ $(basename "$journey") exited $got (0 = pass, 3 = machine-gate SKIP)"
    fail=1
  fi
done

# Regression reproducers: each one re-runs a defect that is fixed and must
# exit 0; a non-zero exit means the defect is back (or the reproducer itself
# rotted), and either fails the suite.
for repro in "$here"/repro-journey-*.ts; do
  if printf '%s\n' "$claimed" | grep -qx "$(basename "$repro")"; then continue; fi
  [ -e "$repro" ] || continue
  echo
  echo "── $(basename "$repro") ──"
  __t=$SECONDS; (cd "$repo" && "$bun" run "$repro") || fail=1; prover_mark "$repro" "$__t"
done

echo
echo "############################################################"
if [ "$fail" = "0" ]; then echo "# ✅ attention PASS"; else echo "# ❌ attention FAILED"; fi
echo "############################################################"
exit "$fail"
