#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/platform/update-channel/** scripts/release/** scripts/updater/**
# gate-watch: .github/workflows/private-release.yml
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/update-reliability"
fail=0

echo "############################################################"
echo "# UPDATE-RELIABILITY — the private-channel field-fix lane"
echo "############################################################"

drive_members update-reliability 'scripts/update-reliability/$name' "$here/members.txt" || fail=1

echo
echo "############################################################"
if [ "$fail" = "0" ]; then echo "# ✅ UPDATE-RELIABILITY PASS"; else echo "# ❌ UPDATE-RELIABILITY FAILED"; fi
echo "############################################################"
exit "$fail"
