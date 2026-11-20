#!/usr/bin/env bash
# gate-class: pure
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/capabilities"
fail=0
echo "############################################################"
echo "# Capability Graduation Matrix — proof harness"
echo "############################################################"
drive_members capabilities 'scripts/capabilities/$name' "$here/members.txt" || fail=1
echo "############################################################"
if [ "$fail" = "0" ]; then echo "# ✅ ALL CAPABILITY PROOFS PASS"; else echo "# ❌ SOME CAPABILITY PROOFS FAILED"; fi
echo "############################################################"
exit "$fail"
