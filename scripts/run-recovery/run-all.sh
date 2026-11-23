#!/usr/bin/env bash
# gate-class: cpu
# gate-watch: src/**
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/run-recovery"
fail=0

echo "############################################################"
echo "# MERCURY run-recovery — cross-domain integration lane"
echo "############################################################"

drive_members run-recovery 'scripts/run-recovery/$name' "$here/members.txt" || fail=1

echo "############################################################"
if [ "$fail" = 0 ]; then echo "# ✅ run-recovery SUITE OK"; else echo "# ❌ run-recovery SUITE FAILED"; fi
echo "############################################################"
exit "$fail"
