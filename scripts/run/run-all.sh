#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/services/run/**
# gate-watch: src/utils/hooks/unfinishedTail* src/utils/cockpit/contextUsageLive*
# gate-watch: src/utils/cockpit/ctxForecast* src/utils/verification/verificationState*
# ============================================================================
#  scripts/run/run-all.sh — the autonomous-run kernel proof suite.
#  Owner-addressed run state, evidence-based completion, durable run sidecars,
#  and resume reconciliation (the Sol 5.6 frontier sprint). Globs prove-*.ts
#  so new proofs auto-join; the suite itself auto-joins the green gate via
#  scripts/run-all-suites.sh's scripts/*/run-all.sh glob.
# ============================================================================
set -u
# One wall-seconds line per prover — the pool engine reads exactly this shape.
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss\n' "$p" "$(( SECONDS - $2 ))"; }

here="$(cd "$(dirname "$0")" && pwd)"
bun="${BUN:-$HOME/.bun/bin/bun}"
fail=0
echo "############################################################"
echo "# run — autonomous-run kernel proof harness"
echo "############################################################"
shopt -s nullglob
for proof in "$here"/prove-*.ts; do
  echo
  echo "── $(basename "$proof") ──"
  __t=$SECONDS; "$bun" run "$proof" || fail=1; prover_mark "$proof" "$__t"
done
exit $fail
