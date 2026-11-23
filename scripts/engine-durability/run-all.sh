#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/engine/run/** src/screen/workbench/**
# gate-watch: src/engine/loop/turn/**
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/engine-durability"
fail=0

echo "############################################################"
echo "# engine-durability — state integrity"
echo "############################################################"

drive_members engine-durability 'scripts/engine-durability/$name' "$here/members.txt" || fail=1

echo "############################################################"
if [ "$fail" = "0" ]; then echo "# ✅ ENGINE-DURABILITY PASS"; else echo "# ❌ ENGINE-DURABILITY FAILED"; fi
echo "############################################################"
exit $fail
