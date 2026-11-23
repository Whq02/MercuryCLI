#!/usr/bin/env bash
# gate-class: cpu
# gate-watch: src/platform/settings/*
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/tree-ownership"
fail=0
echo "############################################################"
echo "# tree-ownership — §13 native-ownership proofs"
echo "############################################################"
drive_members tree-ownership 'scripts/tree-ownership/$name' "$here/members.txt" || fail=1
echo "############################################################"
if [ "$fail" = "0" ]; then echo "# ✅ ALL tree-ownership PROOFS PASS"; else echo "# ❌ SOME tree-ownership PROOFS FAILED"; fi
exit "$fail"
