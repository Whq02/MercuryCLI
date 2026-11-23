#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/**
# gate-watch: scripts/lib/captureDriver.ts
# gate-watch: scripts/streaming/artifactArena.ts
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/interview"
fail=0

echo "############################################################"
echo "# INTERVIEW — the evidence-first design-conversation lane"
echo "############################################################"

drive_members interview 'scripts/interview/$name' "$here/members.txt" || fail=1

echo
echo "############################################################"
if [ "$fail" = "0" ]; then echo "# ✅ INTERVIEW PASS"; else echo "# ❌ INTERVIEW FAILED"; fi
echo "############################################################"
exit "$fail"
