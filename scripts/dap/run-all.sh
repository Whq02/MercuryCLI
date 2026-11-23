#!/usr/bin/env bash
# gate-class: pure
# gate-watch: vendor/dap-adapters.lock.json
# gate-watch: src/**
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/dap"
fail=0
echo "############################################################"
echo "# dap — proof harness"
echo "############################################################"
drive_members dap 'scripts/dap/$name' "$here/members.txt" || fail=1
echo "############################################################"
if [ "$fail" = "0" ]; then echo "# ✅ ALL DAP PROOFS PASS"; else echo "# ❌ SOME DAP PROOFS FAILED"; fi
echo "############################################################"
exit "$fail"
