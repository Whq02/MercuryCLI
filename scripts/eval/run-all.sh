#!/usr/bin/env bash
# gate-class: cpu
# gate-watch: src/services/eval/** src/tools/EvalTool/**
# gate-watch: src/utils/router/providerSecrets* src/substrate/flagRegistry*
# The eval-kernel estate — proof harness: retained-kernel persistence ·
# the cancellation lattice · tool re-entry under the ruled permission law ·
# the derived credential env filter · bounded output + spill artifacts ·
# in-cell orchestration (agent/parallel/pipeline/completion over the
# loopback fixture, both dialects). Globs prove-*.ts so every new proof
# joins the gate automatically; non-zero exit on any fail.
set -u
# One wall-seconds line per prover — the pool engine reads exactly this shape.
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss\n' "$p" "$(( SECONDS - $2 ))"; }

here="$(cd "$(dirname "$0")" && pwd)"
bun="${BUN:-$HOME/.bun/bin/bun}"
fail=0
echo "############################################################"
echo "# eval kernels — proof harness"
echo "############################################################"
for proof in "$here"/prove-*.ts; do
  [ -e "$proof" ] || continue
  echo
  echo ">>> $(basename "$proof")"
  __t=$SECONDS; "$bun" run "$proof" || fail=1; prover_mark "$proof" "$__t"
done
echo "############################################################"
if [ "$fail" = "0" ]; then echo "# ✅ ALL EVAL PROOFS PASS"; else echo "# ❌ SOME EVAL PROOFS FAILED"; fi
echo "############################################################"
exit "$fail"
