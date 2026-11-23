#!/usr/bin/env bash
# gate-class: cpu
# gate-watch: src/**
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/computer"
fail=0
export MERCURY_CREDENTIAL_STORE="${MERCURY_CREDENTIAL_STORE:-file}"
echo "############################################################"
echo "# computer — the Computer tool's proofs"
echo "############################################################"
drive_members computer 'scripts/computer/$name' "$here/members.txt" || fail=1
echo "############################################################"
if [ "$fail" = "0" ]; then echo "# ✅ ALL COMPUTER PROOFS PASS"; else echo "# ❌ SOME COMPUTER PROOFS FAILED"; fi
echo "############################################################"
exit "$fail"
