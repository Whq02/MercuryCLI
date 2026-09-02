#!/usr/bin/env bash
# gate-class: pure
# Source-integrity proofs — static tripwires the typecheck/runtime suites miss.
# Auto-joins scripts/run-all-suites.sh via the scripts/*/run-all.sh glob.
# Non-zero exit on any fail.
set -u
# One wall-seconds line per prover — the pool engine reads exactly this shape.
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss\n' "$p" "$(( SECONDS - $2 ))"; }

here="$(cd "$(dirname "$0")" && pwd)"
bun="${BUN:-$HOME/.bun/bin/bun}"
fail=0
echo "############################################################"
echo "# Source integrity — no stray control chars + skill-copy sync"
echo "############################################################"
__t=$SECONDS; "$bun" run "$here/prove-no-stray-control-chars.ts" || fail=1; prover_mark "$here/prove-no-stray-control-chars.ts" "$__t"
__t=$SECONDS; "$bun" run "$here/prove-user-skill-sync.ts" || fail=1; prover_mark "$here/prove-user-skill-sync.ts" "$__t"
echo "############################################################"
if [ "$fail" = "0" ]; then echo "# ✅ ALL INTEGRITY PROOFS PASS"; else echo "# ❌ SOME INTEGRITY PROOFS FAILED"; fi
echo "############################################################"
exit "$fail"
