#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/QueryEngine* src/Tool* src/bootstrap/state* src/query/**
# gate-watch: src/services/api/errors* src/utils/**
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss rc=%s\n' "$p" "$(( SECONDS - $2 ))" "${3:?proof exit code required}"; }

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fail=0
echo "── turn-engine proofs ──"
__t=$SECONDS; __rc=0; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-turn-engine-contracts.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-turn-engine-contracts.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-queryengine-laws.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-queryengine-laws.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-query-laws.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-query-laws.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-ptl-recovery.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-ptl-recovery.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-turn-cap-vocabulary.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-turn-cap-vocabulary.ts" "$__t" "$__rc"
"${BUN:-$HOME/.bun/bin/bun}" -e "
await import('$here/../../src/query.ts')
await import('$here/../../src/QueryEngine.ts')
console.log('  [PASS] both turn-engine modules bun-load')
" || { echo "  [FAIL] loadability probe"; fail=1; }
if [[ "$fail" == "0" ]]; then echo "✅ TURNENGINE SUITE GREEN"; exit 0; else
  echo "❌ TURNENGINE SUITE RED"; exit 1; fi
