#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/utils/model/** src/utils/healthReport*
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss rc=%s\n' "$p" "$(( SECONDS - $2 ))" "${3:?proof exit code required}"; }

here="$(cd "$(dirname "$0")" && pwd)"
bun="${BUN:-$HOME/.bun/bin/bun}"
fail=0
echo "############################################################"
echo "# model-policy — frontier-operator proofs"
echo "############################################################"
__t=$SECONDS; __rc=0; "$bun" run "$here/prove-frontier-policy.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-frontier-policy.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "$bun" run "$here/prove-model-policy-surfaces.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-model-policy-surfaces.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "$bun" run "$here/prove-model-pin-census.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-model-pin-census.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "$bun" run "$here/prove-small-fast-family.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-small-fast-family.ts" "$__t" "$__rc"
echo "############################################################"
if [ "$fail" = "0" ]; then echo "# ✅ ALL MODEL-POLICY PROOFS PASS"; else echo "# ❌ SOME MODEL-POLICY PROOFS FAILED"; fi
echo "############################################################"
exit "$fail"
