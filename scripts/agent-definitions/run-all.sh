#!/usr/bin/env bash
# gate-class: cpu
# gate-watch: src/services/agents/* src/components/agents/* src/utils/markdownConfigLoader*
# gate-watch: src/components/agents/studio/*
# gate-watch: src/tools/AgentTool/*
# gate-watch: src/run-core/turn/**
# gate-watch: src/cli/headless/*
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/agent-definitions"
fail=0
export MERCURY_EVOLUTION_LEDGER=0
echo "############################################################"
echo "# agent-definitions — Agent Studio proof harness"
echo "############################################################"
drive_members agent-definitions 'scripts/agent-definitions/$name' "$here/members.txt" || fail=1
echo "############################################################"
if [ "$fail" = "0" ]; then echo "# ✅ ALL agent-definitions PROOFS PASS"; else echo "# ❌ SOME agent-definitions PROOFS FAILED"; fi
echo "############################################################"
exit "$fail"
