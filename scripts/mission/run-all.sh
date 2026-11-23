#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/commands/mission/**
# gate-watch: src/sessions/mission/** src/models/jev/**
# gate-watch: src/permissions/guards/**
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/mission"
fail=0
echo "############################################################"
echo "# /mission stop-hook — proof harness"
echo "############################################################"
drive_members mission 'scripts/mission/$name' "$here/members.txt" || fail=1
echo "############################################################"
if [ "$fail" = "0" ]; then echo "# ✅ ALL MISSION PROOFS PASS"; else echo "# ❌ SOME MISSION PROOFS FAILED"; fi
echo "############################################################"
exit "$fail"
