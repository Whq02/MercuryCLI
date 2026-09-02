#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/memdir/** src/services/mcp/coordinationServer*
# MNEME — topic-document memory proof harness (paper-triad Slice B).
# Non-zero exit on any fail. Explicit list — wire NEW proofs in here (the
# autocompact-verbatim-tail lesson: suites are explicit lists).
set -u
# One wall-seconds line per prover — the pool engine reads exactly this shape.
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss\n' "$p" "$(( SECONDS - $2 ))"; }

here="$(cd "$(dirname "$0")" && pwd)"
bun="${BUN:-$HOME/.bun/bin/bun}"
fail=0
echo "############################################################"
echo "# MNEME topic-document memory — proof harness"
echo "############################################################"
__t=$SECONDS; "$bun" run "$here/prove-topic-memory-lifecycle.ts" || fail=1; prover_mark "$here/prove-topic-memory-lifecycle.ts" "$__t"
__t=$SECONDS; "$bun" run "$here/prove-topic-memory-validator.ts" || fail=1; prover_mark "$here/prove-topic-memory-validator.ts" "$__t"
__t=$SECONDS; "$bun" run "$here/prove-topic-memory-maintenance.ts" || fail=1; prover_mark "$here/prove-topic-memory-maintenance.ts" "$__t"
__t=$SECONDS; "$bun" run "$here/prove-topic-memory-concurrency.ts" || fail=1; prover_mark "$here/prove-topic-memory-concurrency.ts" "$__t"
__t=$SECONDS; "$bun" run "$here/prove-topic-memory-verbs.ts" || fail=1; prover_mark "$here/prove-topic-memory-verbs.ts" "$__t"
if [ "$fail" -ne 0 ]; then
  echo "❌ topic-memory suite: FAILURES"
  exit 1
fi
echo "✅ topic-memory suite: ALL GREEN"
