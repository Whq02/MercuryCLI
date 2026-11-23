#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/**
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/cache"
fail=0
echo "############################################################"
echo "# Cache Clock — proof harness"
echo "############################################################"
drive_members cache 'scripts/cache/$name' "$here/members.txt" || fail=1
echo "############################################################"
if [ "$fail" = "0" ]; then echo "# ✅ ALL CACHE PROOFS PASS"; else echo "# ❌ SOME CACHE PROOFS FAILED"; fi
echo "############################################################"
exit "$fail"
