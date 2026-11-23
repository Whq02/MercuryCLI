#!/usr/bin/env bash
# gate-class: cpu
# gate-watch: src/tools/aseprite/**
# gate-watch: src/platform/substrate/flagRegistry.ts src/platform/substrate/startupMenu.ts src/screen/cockpit-gauges/harnessMap.ts
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/aseprite"
fail=0
echo "############################################################"
echo "# aseprite — proof harness"
echo "############################################################"

drive_members aseprite 'scripts/aseprite/$name' "$here/members.txt" || fail=1
echo "############################################################"
if [ "$fail" = "0" ]; then echo "# ✅ ALL ASEPRITE PROOFS PASS"; else echo "# ❌ SOME ASEPRITE PROOFS FAILED"; fi
echo "############################################################"
exit "$fail"
