#!/usr/bin/env bash
# gate-class: cpu
# gate-watch: src/crew/agents/* src/daemon/runner/* src/engine/loop/turn/**
# gate-watch: src/engine/system-prompt/*
# gate-watch: src/platform/settings/*
# gate-watch: src/screen/agents/**
# gate-watch: src/tools/crewmate/*
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
