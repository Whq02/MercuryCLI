#!/usr/bin/env bash
# gate-class: cpu
# gate-watch: sdk/** sdk-py/** src/boot/sessionArgs.ts src/daemon/runner/* src/engine/rows/**
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/sdk"
fail=0
echo "############################################################"
echo "# sdk — TypeScript and Python: build, drift, run, runner and testing"
echo "############################################################"
[ -d "$here/../../sdk/src" ] || { echo "the SDK is parked and not on this tree (the published lineage carries no sdk/): nothing to prove here"; exit 0; }
drive_members sdk 'scripts/sdk/$name' "$here/members.txt" || fail=1
exit $fail
