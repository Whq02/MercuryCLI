#!/usr/bin/env bash
# gate-class: pure
# gate-watch: scripts/orphans/** build.ts src/entrypoints/**
# gate-watch: src/substrate/flagRegistry.ts
# scripts/orphans/run-all.sh — the reachability-truth suite (the dead-code
# ratchet; typed baseline +
# discrimination + the reachability manifest). Glob-run so every landed
# prove-*.ts joins the pooled green gate automatically.
set -uo pipefail
# One wall-seconds line per prover — the pool engine reads exactly this shape.
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss\n' "$p" "$(( SECONDS - $2 ))"; }

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
bun="${BUN:-$HOME/.bun/bin/bun}"
fail=0
shopt -s nullglob
for proof in "$here"/prove-*.ts; do
  echo "── orphans: $(basename "$proof") ──"
  __t=$SECONDS; (cd "$repo" && "$bun" run "$proof") || fail=1; prover_mark "$proof" "$__t"
done
if [[ "$fail" == "0" ]]; then echo "✅ ORPHANS SUITE GREEN"; exit 0; else
  echo "❌ ORPHANS SUITE RED"; exit 1; fi
