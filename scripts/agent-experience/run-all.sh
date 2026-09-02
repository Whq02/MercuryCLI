#!/usr/bin/env bash
# gate-class: cpu
# gate-watch: scripts/agent-experience/** src/constants/prompts* src/prompt/**
# gate-watch: src/utils/systemPrompt* src/tools/AgentTool/built-in/** src/constants/subagentDoctrine*
# scripts/agent-experience/run-all.sh — the agent-experience suite: the
# cold-start benchmark's MECHANICAL legs (every provider family on the
# loopback fixture, zero spend, bounded) plus the harness's own laws and the
# ratchet against the committed baseline. The live leg never runs here —
# `bash scripts/agent-experience/benchmark.sh --live` is the operator's call.
# Requires the prebuilt dist (the pooled gate prebuilds it).
set -u
# One wall-seconds line per prover — the pool engine reads exactly this shape.
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss\n' "$p" "$(( SECONDS - $2 ))"; }

here="$(cd "$(dirname "$0")" && pwd)"
bun="${BUN:-$HOME/.bun/bin/bun}"
fail=0
echo "############################################################"
echo "# agent-experience — the cold-start benchmark (mechanical legs)"
echo "############################################################"
shopt -s nullglob
for proof in "$here"/prove-*.ts; do
  echo
  echo "── $(basename "$proof") ──"
  __t=$SECONDS; "$bun" run "$proof" || fail=1; prover_mark "$proof" "$__t"
done
exit $fail
