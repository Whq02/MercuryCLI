#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/services/providers/openrouter/** src/services/providers/gemini/**
# gate-watch: src/services/providers/**
# gate-watch: src/services/wallet/**
# gate-watch: src/services/anthropicLimits*
# gate-watch: src/cli/run.ts
# gate-watch: src/components/*
# gate-watch: src/services/api/*
# gate-watch: src/services/providers/*
# gate-watch: src/services/providers/huggingface/*
# gate-watch: src/services/providers/moonshot/* src/services/providers/openai/* src/services/providers/meta/**
# gate-watch: src/utils/*
# gate-watch: src/utils/model/*
# gate-watch: src/run-core/turn-machine.ts src/services/compact/**
# gate-watch: src/run-core/turn/**
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss rc=%s\n' "$p" "$(( SECONDS - $2 ))" "${3:?proof exit code required}"; }

here="$(cd "$(dirname "$0")" && pwd)"
bun="${BUN:-$HOME/.bun/bin/bun}"
fail=0
export MERCURY_EVOLUTION_LEDGER=0
echo "############################################################"
echo "# PROVAUTH — provider auth proof harness"
echo "############################################################"
shopt -s nullglob
for proof in "$here"/prove-*.ts; do
  echo ""
  __t=$SECONDS; __rc=0; if ! { "$bun" run "$proof"; __rc=$?; [ "$__rc" -eq 0 ]; }; then
    fail=$((fail + 1))
  fi
  prover_mark "$proof" "$__t" "$__rc"
done
echo ""
if [ "$fail" -gt 0 ]; then
  echo "❌ provauth suite: $fail prover(s) red"
  exit 1
fi
echo "✅ provauth suite green"
