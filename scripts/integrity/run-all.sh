#!/usr/bin/env bash
# gate-class: pure
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss rc=%s\n' "$p" "$(( SECONDS - $2 ))" "${3:?proof exit code required}"; }

here="$(cd "$(dirname "$0")" && pwd)"
bun="${BUN:-$HOME/.bun/bin/bun}"
fail=0
echo "############################################################"
echo "# Source integrity — no stray control chars + skill-copy sync"
echo "############################################################"
__t=$SECONDS; __rc=0; "$bun" run "$here/prove-no-stray-control-chars.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-no-stray-control-chars.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "$bun" run "$here/prove-user-skill-sync.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-user-skill-sync.ts" "$__t" "$__rc"
echo "############################################################"
if [ "$fail" = "0" ]; then echo "# ✅ ALL INTEGRITY PROOFS PASS"; else echo "# ❌ SOME INTEGRITY PROOFS FAILED"; fi
echo "############################################################"
exit "$fail"
