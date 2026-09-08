#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/memdir/** src/services/mcp/coordinationServer*
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss rc=%s\n' "$p" "$(( SECONDS - $2 ))" "${3:?proof exit code required}"; }

here="$(cd "$(dirname "$0")" && pwd)"
bun="${BUN:-$HOME/.bun/bin/bun}"
fail=0
echo "############################################################"
echo "# MNEME topic-document memory — proof harness"
echo "############################################################"
__t=$SECONDS; __rc=0; "$bun" run "$here/prove-topic-memory-lifecycle.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-topic-memory-lifecycle.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "$bun" run "$here/prove-topic-memory-validator.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-topic-memory-validator.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "$bun" run "$here/prove-topic-memory-maintenance.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-topic-memory-maintenance.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "$bun" run "$here/prove-topic-memory-concurrency.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-topic-memory-concurrency.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "$bun" run "$here/prove-topic-memory-verbs.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-topic-memory-verbs.ts" "$__t" "$__rc"
if [ "$fail" -ne 0 ]; then
  echo "❌ topic-memory suite: FAILURES"
  exit 1
fi
echo "✅ topic-memory suite: ALL GREEN"
