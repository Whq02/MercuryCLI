#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/Tool* src/utils/errors/** src/utils/permissions/decision/**
# gate-watch: src/utils/permissions/denialTracking* src/utils/permissions/permissions*
# ============================================================================
#  scripts/decisions/run-all.sh — the permission decision-chain proof suite.
#  Freezes the ordered stage contract of the decision engine (kill-switch →
#  deny/ask rules → tool verdicts → bypass-immunity band → mode band →
#  allow rules → passthrough conversion → the dontAsk/auto wrapper with its
#  pre-classifier floors) by driving the REAL engine with fake tools over a
#  decision table.
#  Complements scripts/permissions (classifier fallback, abort totality,
#  commit gate, mode niceties). Globs prove-*.ts; auto-joins the pooled gate.
# ============================================================================
set -u
# One wall-seconds line per prover — the pool engine reads exactly this shape.
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss\n' "$p" "$(( SECONDS - $2 ))"; }

here="$(cd "$(dirname "$0")" && pwd)"
bun="${BUN:-$HOME/.bun/bin/bun}"
fail=0
echo "############################################################"
echo "# decisions — permission decision-chain proof harness"
echo "############################################################"
shopt -s nullglob
for proof in "$here"/prove-*.ts; do
  echo
  echo "── $(basename "$proof") ──"
  __t=$SECONDS; "$bun" run "$proof" || fail=1; prover_mark "$proof" "$__t"
done
exit $fail
