#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/daemon/headlessRun* src/utils/model/agent* src/utils/model/modelFloor*
# Never-Haiku model floor — proof harness. Runs every scripts/model-floor/prove-*.ts
# via bun run; non-zero exit on any failure. New proofs are picked up by the glob.
set -u
# One wall-seconds line per prover — the pool engine reads exactly this shape.
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss\n' "$p" "$(( SECONDS - $2 ))"; }

here="$(cd "$(dirname "$0")" && pwd)"
bun="${BUN:-$HOME/.bun/bin/bun}"
fail=0
echo "############################################################"
echo "# Never-Haiku model floor — proof harness"
echo "############################################################"
shopt -s nullglob
for proof in "$here"/prove-*.ts; do
  echo
  echo ">>> $(basename "$proof")"
  __t=$SECONDS; "$bun" run "$proof" || fail=1; prover_mark "$proof" "$__t"
done
echo "############################################################"
if [ "$fail" = "0" ]; then echo "# ✅ ALL MODEL-FLOOR PROOFS PASS"; else echo "# ❌ SOME MODEL-FLOOR PROOFS FAILED"; fi
echo "############################################################"
exit "$fail"
