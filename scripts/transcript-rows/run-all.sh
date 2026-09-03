#!/usr/bin/env bash
# gate-class: cpu
# gate-watch: src/ink/** src/utils/cockpit/**
# scripts/transcript-rows/run-all.sh — COCKPIT proof suite
# Auto-joins the pooled green gate via
# the scripts/*/run-all.sh glob.
#
# Provers glob in (the orphaned-prover lesson): every prove-*.ts here runs;
# a RED prover fails the suite. capture-baseline.ts is NOT a prover — it is
# the operator-run measurement instrument.
set -uo pipefail
# One wall-seconds line per prover — the pool engine reads exactly this shape.
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss\n' "$p" "$(( SECONDS - $2 ))"; }

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fail=0
echo "── transcript-rows proofs ──"
# Provers named by a sibling member list (scripts/transcript-rows-*/members.txt) run in
# that sibling suite — the real-terminal drives — never here.
claimed=$(cat scripts/transcript-rows-*/members.txt 2>/dev/null | grep -v '^#' | grep -v '^$')

for f in "$here"/prove-*.ts; do
  if printf '%s\n' "$claimed" | grep -qx "$(basename "$f")"; then continue; fi
  [ -e "$f" ] || continue
  __t=$SECONDS; "${BUN:-$HOME/.bun/bin/bun}" run "$f" || fail=1; prover_mark "$f" "$__t"
done
if [[ "$fail" == "0" ]]; then echo "✅ TRANSCRIPT-ROWS SUITE GREEN"; exit 0; else
  echo "❌ TRANSCRIPT-ROWS SUITE RED"; exit 1; fi
