#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/QueryEngine* src/screens/REPL* src/utils/hooks/commitGate*
# gate-watch: src/utils/verification/verificationState*
# gate-watch: src/utils/hooks/generatedAssets* scripts/gate/generated-assets.tsv scripts/gate/generated-assets.ts
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss rc=%s\n' "$p" "$(( SECONDS - $2 ))" "${3:?proof exit code required}"; }

here="$(cd "$(dirname "$0")" && pwd)"
bun="${BUN:-$HOME/.bun/bin/bun}"
fail=0
echo "############################################################"
echo "# &&-commit-gate — proof harness"
echo "############################################################"
__t=$SECONDS; __rc=0; "$bun" run "$here/prove-commit-gate-wiring.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-commit-gate-wiring.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "$bun" run "$here/prove-commit-gate.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-commit-gate.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "$bun" run "$here/prove-generated-assets.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-generated-assets.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; bash "$here/prove-shell.sh" || { __rc=$?; fail=1; }; prover_mark "$here/prove-shell.sh" "$__t" "$__rc"
echo "############################################################"
if [ "$fail" = "0" ]; then echo "# ✅ ALL PROOFS PASS"; else echo "# ❌ SOME PROOFS FAILED"; fi
echo "############################################################"
exit "$fail"
