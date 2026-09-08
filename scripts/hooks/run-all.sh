#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/utils/hooks/**
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss rc=%s\n' "$p" "$(( SECONDS - $2 ))" "${3:?proof exit code required}"; }

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fail=0
echo "── hooks-engine proofs ──"
__t=$SECONDS; __rc=0; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-hooks-parity.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-hooks-parity.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-hook-pipe-settle.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-hook-pipe-settle.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-timeout-not-cancelled.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-timeout-not-cancelled.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-hook-detail-fields.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-hook-detail-fields.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-hook-nonzero-report.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-hook-nonzero-report.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-once-hook-retires.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-once-hook-retires.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-if-event-honesty.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-if-event-honesty.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-sh-hook-spelling.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-sh-hook-spelling.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-ssrf-v6-spellings.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-ssrf-v6-spellings.ts" "$__t" "$__rc"
__t=$SECONDS; __rc=0; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-skill-hooks-deapply.ts" || { __rc=$?; fail=1; }; prover_mark "$here/prove-skill-hooks-deapply.ts" "$__t" "$__rc"
if [[ "$fail" == "0" ]]; then echo "✅ HOOKS SUITE GREEN"; exit 0; else
  echo "❌ HOOKS SUITE RED"; exit 1; fi
