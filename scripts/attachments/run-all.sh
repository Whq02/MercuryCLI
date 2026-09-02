#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/utils/attachments/**
# scripts/attachments/run-all.sh — context-assembly proof suite. Auto-joins the pooled green gate via the glob.
# The golden-replay oracle covers the pure export subset; the stateful
# producer family is pinned by the standing substrate suites and gains
# fixture cases as the R3 extraction reaches each producer.
set -uo pipefail
# One wall-seconds line per prover — the pool engine reads exactly this shape.
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss\n' "$p" "$(( SECONDS - $2 ))"; }

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fail=0
echo "── context-assembly proofs ──"
__t=$SECONDS; "${BUN:-$HOME/.bun/bin/bun}" run "$here/prove-attachments-parity.ts" || fail=1; prover_mark "$here/prove-attachments-parity.ts" "$__t"
if [[ "$fail" == "0" ]]; then echo "✅ ATTACHMENTS SUITE GREEN"; exit 0; else
  echo "❌ ATTACHMENTS SUITE RED"; exit 1; fi
