#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/utils/hooks/**
# scripts/hooks/run-all.sh — hooks-engine proof suite. Auto-joins the pooled green gate via the glob.
set -uo pipefail
# One wall-seconds line per prover — the pool engine reads exactly this shape.
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss\n' "$p" "$(( SECONDS - $2 ))"; }

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fail=0
echo "── hooks-engine proofs ──"
__t=$SECONDS; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-hooks-parity.ts" || fail=1; prover_mark "$here/prove-hooks-parity.ts" "$__t"
__t=$SECONDS; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-hook-pipe-settle.ts" || fail=1; prover_mark "$here/prove-hook-pipe-settle.ts" "$__t"
__t=$SECONDS; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-timeout-not-cancelled.ts" || fail=1; prover_mark "$here/prove-timeout-not-cancelled.ts" "$__t"
__t=$SECONDS; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-hook-detail-fields.ts" || fail=1; prover_mark "$here/prove-hook-detail-fields.ts" "$__t"
__t=$SECONDS; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-hook-nonzero-report.ts" || fail=1; prover_mark "$here/prove-hook-nonzero-report.ts" "$__t"
__t=$SECONDS; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-once-hook-retires.ts" || fail=1; prover_mark "$here/prove-once-hook-retires.ts" "$__t"
__t=$SECONDS; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-if-event-honesty.ts" || fail=1; prover_mark "$here/prove-if-event-honesty.ts" "$__t"
__t=$SECONDS; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-sh-hook-spelling.ts" || fail=1; prover_mark "$here/prove-sh-hook-spelling.ts" "$__t"
__t=$SECONDS; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-ssrf-v6-spellings.ts" || fail=1; prover_mark "$here/prove-ssrf-v6-spellings.ts" "$__t"
__t=$SECONDS; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-skill-hooks-deapply.ts" || fail=1; prover_mark "$here/prove-skill-hooks-deapply.ts" "$__t"
if [[ "$fail" == "0" ]]; then echo "✅ HOOKS SUITE GREEN"; exit 0; else
  echo "❌ HOOKS SUITE RED"; exit 1; fi
