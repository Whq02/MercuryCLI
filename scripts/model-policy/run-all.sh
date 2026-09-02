#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/utils/model/** src/utils/healthReport*
# the frontier-operator policy proof suite (decision matrix +
# surface/census). Non-zero exit on any fail.
set -u
# One wall-seconds line per prover — the pool engine reads exactly this shape.
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss\n' "$p" "$(( SECONDS - $2 ))"; }

here="$(cd "$(dirname "$0")" && pwd)"
bun="${BUN:-$HOME/.bun/bin/bun}"
fail=0
echo "############################################################"
echo "# model-policy — frontier-operator proofs"
echo "############################################################"
__t=$SECONDS; "$bun" run "$here/prove-frontier-policy.ts" || fail=1; prover_mark "$here/prove-frontier-policy.ts" "$__t"
__t=$SECONDS; "$bun" run "$here/prove-model-policy-surfaces.ts" || fail=1; prover_mark "$here/prove-model-policy-surfaces.ts" "$__t"
__t=$SECONDS; "$bun" run "$here/prove-model-pin-census.ts" || fail=1; prover_mark "$here/prove-model-pin-census.ts" "$__t"
__t=$SECONDS; "$bun" run "$here/prove-small-fast-family.ts" || fail=1; prover_mark "$here/prove-small-fast-family.ts" "$__t"
echo "############################################################"
if [ "$fail" = "0" ]; then echo "# ✅ ALL MODEL-POLICY PROOFS PASS"; else echo "# ❌ SOME MODEL-POLICY PROOFS FAILED"; fi
echo "############################################################"
exit "$fail"
