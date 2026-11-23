#!/usr/bin/env bash
# gate-class: cpu
# gate-watch: src/**
# gate-watch: assets/splash/splash-core.mjs
# gate-watch: docs/CREW.md docs/ENGINES.md docs/HEALTH-CERTIFICATE.md docs/KIT.md docs/MCP-SERVER.md docs/SESSIONS.md docs/SETTINGS.md
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/notifications"
fail=0

echo "############################################################"
echo "# notifications — the Session Concourse lane"
echo "############################################################"

drive_members notifications 'scripts/notifications/$name' "$here/members.txt" || fail=1

echo
echo "############################################################"
if [ "$fail" = "0" ]; then echo "# ✅ notifications PASS"; else echo "# ❌ notifications FAILED"; fi
echo "############################################################"
exit "$fail"
