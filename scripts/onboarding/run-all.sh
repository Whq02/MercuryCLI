#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/models/roads/local/tensorfoldHosts.ts src/models/tensorfold/** src/screen/tensorfold/**
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/onboarding"
fail=0
echo "############################################################"
echo "# Fast onboarding"
echo "############################################################"
drive_members onboarding 'scripts/onboarding/$name' "$here/members.txt" || fail=1
echo "############################################################"
if [ "$fail" = "0" ]; then echo "# ✅ ONBOARDING PASS"; else echo "# ❌ ONBOARDING FAILED"; fi
echo "############################################################"
exit "$fail"
