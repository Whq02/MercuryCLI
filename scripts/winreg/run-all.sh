#!/usr/bin/env bash
# gate-class: pure
# gate-watch: scripts/ui/vshot.py package.json
# gate-watch: scripts/lib/captureDriver.ts scripts/lib/capture_refusal.py scripts/switchboard/prove-session-unification.ts
# gate-watch: scripts/lib/capturePreflight.ts scripts/ui/render-tui.ts
# gate-watch: src/**
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78
cd "$(dirname "$0")/../.." || exit 1
here="scripts/winreg"
fail=0

echo "############################################################"
echo "# WINREG — Windows capture plane (local provable half)"
echo "############################################################"

drive_members winreg 'scripts/winreg/$name' "$here/members.txt" || fail=1

exit "$fail"
