#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/prompt/** src/constants/prompts.ts scripts/behaviour-laws/**
# ============================================================================
#  scripts/behaviour-laws/run-all.sh — the behavioural-contract laws.
#
#    prove-behaviour-laws-contract  — repository-owned generation (bridge retired ·
#                          doctrine gate · byte-stability · semantic IDs)
#    prove-behaviour-laws-render    — the REAL rendered contract end-to-end: provider
#                          scoping (zero Claude-currency on the OpenAI wire ·
#                          gpt delta openai-only) · one-owner dedup ·
#                          stale-name law
#
#  The capture-*.ts files here are MEASUREMENT tools (the baseline/
#  candidate posture matrix), not gate members — only prove-*.ts joins.
#  Auto-joins the green-gate via scripts/run-all-suites.sh.
# ============================================================================
set -u
# One wall-seconds line per prover — the pool engine reads exactly this shape.
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss\n' "$p" "$(( SECONDS - $2 ))"; }

here="$(cd "$(dirname "$0")" && pwd)"
bun="${BUN:-$HOME/.bun/bin/bun}"
fail=0

for proof in "$here"/prove-*.ts; do
  name="$(basename "$proof")"
  echo "── $name"
  __t=$SECONDS; if ! "$bun" run "$proof"; then
    echo "❌ $name"
    fail=1
  fi
  prover_mark "$proof" "$__t"
done

exit "$fail"
