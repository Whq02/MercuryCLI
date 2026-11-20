#!/usr/bin/env bash
# gate-class: pure
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/integrity"
fail=0
echo "############################################################"
echo "# Source integrity — no stray control chars + skill-copy sync"
echo "############################################################"
drive_members integrity 'scripts/integrity/$name' "$here/members.txt" || fail=1
echo "############################################################"
if [ "$fail" = "0" ]; then echo "# ✅ ALL INTEGRITY PROOFS PASS"; else echo "# ❌ SOME INTEGRITY PROOFS FAILED"; fi
echo "############################################################"
exit "$fail"
