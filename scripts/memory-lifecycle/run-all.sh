#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/memdir/** src/services/mcp/coordinationServer* src/utils/backgroundHousekeeping* src/query/stopHooks* src/services/autoDream/**
# Memory lifecycle — the practical proof harness.
# Non-zero exit on any fail. Explicit
# list — wire NEW proofs in here (the autocompact-verbatim-tail lesson).
# The bench/ directory holds MEASUREMENT harnesses (before/after receipts,
# billed journey runners) — deliberately NOT gate members.
set -u
# One wall-seconds line per prover — the pool engine reads exactly this shape.
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss\n' "$p" "$(( SECONDS - $2 ))"; }

here="$(cd "$(dirname "$0")" && pwd)"
BUN="${BUN:-$HOME/.bun/bin/bun}"
fail=0
for proof in \
  prove-topic-memory-discoverability.ts \
  prove-topic-memory-correction.ts \
  prove-topic-memory-maintenance.ts \
  prove-memory-refs.ts \
  prove-themis-mission.ts \
; do
  echo "── $proof"
  __t=$SECONDS; if ! "$BUN" run "$here/$proof"; then
    echo "❌ $proof FAILED"
    fail=1
  fi
  prover_mark "$here/$proof" "$__t"
done
if [ "$fail" -ne 0 ]; then
  echo "❌ memory-lifecycle suite: FAILURES"
  exit 1
fi
echo "✅ memory-lifecycle suite: ALL GREEN"
