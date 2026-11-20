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
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/provauth"
fail=0
export MERCURY_EVOLUTION_LEDGER=0
echo "############################################################"
echo "# PROVAUTH — provider auth proof harness"
echo "############################################################"
drive_members provauth 'scripts/provauth/$name' "$here/members.txt" || fail=1
echo ""
if [ "$fail" -gt 0 ]; then
  echo "❌ provauth suite: $fail prover(s) red"
  exit 1
fi
echo "✅ provauth suite green"
