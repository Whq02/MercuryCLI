#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/services/tools/toolExecution* src/substrate/themis/**
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss rc=%s\n' "$p" "$(( SECONDS - $2 ))" "${3:?proof exit code required}"; }

here="$(cd "$(dirname "$0")" && pwd)"
bun="${BUN:-$HOME/.bun/bin/bun}"
fail=0
echo "############################################################"
echo "# THEMIS control plane — proof harness"
echo "############################################################"
__t=$SECONDS; __rc=0; "$bun" run "$here/prove-blocklist.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-blocklist.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "$bun" run "$here/prove-audit-chain.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-audit-chain.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "$bun" run "$here/prove-integrity-drift.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-integrity-drift.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "$bun" run "$here/prove-phases-trace.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-phases-trace.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "$bun" run "$here/prove-sds-contract.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-sds-contract.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "$bun" run "$here/prove-gate-wiring.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-gate-wiring.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "$bun" run "$here/prove-kernel-cell-gate.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-kernel-cell-gate.ts" "$__t" "$__rc"
if [ "$fail" -ne 0 ]; then
  echo "❌ themis suite: FAILURES"
  exit 1
fi
echo "✅ themis suite: ALL GREEN"
