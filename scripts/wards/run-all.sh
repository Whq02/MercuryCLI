#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/**
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/wards"
fail=0
echo "############################################################"
echo "# wards — proof harness"
echo "############################################################"
drive_members wards 'scripts/wards/$name' "$here/members.txt" || fail=1
echo "############################################################"
if [ "$fail" = "0" ]; then echo "# ✅ ALL WARDS PROOFS PASS"; else echo "# ❌ SOME WARDS PROOFS FAILED"; fi
echo "############################################################"
exit "$fail"
