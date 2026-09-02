#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/QueryEngine* src/Tool* src/bootstrap/state* src/query/**
# gate-watch: src/services/api/errors* src/utils/**
# scripts/turnEngine/run-all.sh — turn-engine proof suite. Auto-joins the pooled green gate via the glob.
# Structural preserve-contracts + a loadability probe; the behavioral oracle
# is the full gate itself (every capture/smoke runs the engine).
set -uo pipefail
# One wall-seconds line per prover — the pool engine reads exactly this shape.
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss\n' "$p" "$(( SECONDS - $2 ))"; }

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fail=0
echo "── turn-engine proofs ──"
__t=$SECONDS; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-turn-engine-contracts.ts" || fail=1; prover_mark "$here/prove-turn-engine-contracts.ts" "$__t"
__t=$SECONDS; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-queryengine-laws.ts" || fail=1; prover_mark "$here/prove-queryengine-laws.ts" "$__t"
__t=$SECONDS; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-query-laws.ts" || fail=1; prover_mark "$here/prove-query-laws.ts" "$__t"
__t=$SECONDS; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-ptl-recovery.ts" || fail=1; prover_mark "$here/prove-ptl-recovery.ts" "$__t"
__t=$SECONDS; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-turn-cap-vocabulary.ts" || fail=1; prover_mark "$here/prove-turn-cap-vocabulary.ts" "$__t"
"${BUN:-$HOME/.bun/bin/bun}" -e "
await import('$here/../../src/query.ts')
await import('$here/../../src/QueryEngine.ts')
console.log('  [PASS] both turn-engine modules bun-load')
" || { echo "  [FAIL] loadability probe"; fail=1; }
if [[ "$fail" == "0" ]]; then echo "✅ TURNENGINE SUITE GREEN"; exit 0; else
  echo "❌ TURNENGINE SUITE RED"; exit 1; fi
