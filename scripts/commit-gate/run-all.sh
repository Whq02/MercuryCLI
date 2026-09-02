#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/QueryEngine* src/screens/REPL* src/utils/hooks/commitGate*
# gate-watch: src/utils/verification/verificationState*
set -u
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss\n' "$p" "$(( SECONDS - $2 ))"; }

here="$(cd "$(dirname "$0")" && pwd)"
bun="${BUN:-$HOME/.bun/bin/bun}"
fail=0
echo "############################################################"
echo "# &&-commit-gate — proof harness"
echo "############################################################"
__t=$SECONDS; "$bun" run "$here/prove-commit-gate-wiring.ts" || fail=1; prover_mark "$here/prove-commit-gate-wiring.ts" "$__t"
__t=$SECONDS; "$bun" run "$here/prove-commit-gate.ts" || fail=1; prover_mark "$here/prove-commit-gate.ts" "$__t"
__t=$SECONDS; bash "$here/prove-shell.sh" || fail=1; prover_mark "$here/prove-shell.sh" "$__t"
echo "############################################################"
if [ "$fail" = "0" ]; then echo "# ✅ ALL PROOFS PASS"; else echo "# ❌ SOME PROOFS FAILED"; fi
echo "############################################################"
exit "$fail"
