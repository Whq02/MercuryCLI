#!/usr/bin/env bash
# gate-class: pure
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/projectdirs"
fail=0
export MERCURY_EVOLUTION_LEDGER=0
scratch_state="$(mktemp -d "${TMPDIR:-/tmp}/projectdirs-proof.XXXXXX")"
export MERCURY_PROJECTDIRS_UNUSED="$scratch_state"
trap 'rm -rf "$scratch_state"; suite_home_cleanup' EXIT
echo "############################################################"
echo "# dual project-config — proof harness"
echo "############################################################"
drive_members projectdirs 'scripts/projectdirs/$name' "$here/members.txt" || fail=1
echo "############################################################"
if [ "$fail" = "0" ]; then echo "# ✅ ALL PROJECTDIRS PROOFS PASS"; else echo "# ❌ SOME PROJECTDIRS PROOFS FAILED"; fi
echo "############################################################"
exit "$fail"
