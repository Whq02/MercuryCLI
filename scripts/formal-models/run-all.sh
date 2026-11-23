#!/usr/bin/env bash
# gate-class: pure
# gate-watch: scripts/interview/prove-resume-bounds.ts src/platform/substrate/*
# gate-watch: scripts/orphans/**
# gate-watch: src/tools/engines/interview/**
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/formal-models"
fail=0

echo "############################################################"
echo "# formal-models — production reachability + state-integrity closure"
echo "############################################################"

drive_members formal-models 'scripts/formal-models/$name' "$here/members.txt" || fail=1

echo
echo "############################################################"
if [ "$fail" = "0" ]; then echo "# ✅ formal-models PASS"; else echo "# ❌ formal-models FAILED"; fi
echo "############################################################"
exit "$fail"
