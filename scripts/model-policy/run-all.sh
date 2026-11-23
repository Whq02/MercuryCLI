#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/daemon/runner-wire/* src/engine/rows/*
# gate-watch: src/models/facts/** src/platform/health/*
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/model-policy"
fail=0
echo "############################################################"
echo "# model-policy — frontier-operator proofs"
echo "############################################################"
drive_members model-policy 'scripts/model-policy/$name' "$here/members.txt" || fail=1
echo "############################################################"
if [ "$fail" = "0" ]; then echo "# ✅ ALL MODEL-POLICY PROOFS PASS"; else echo "# ❌ SOME MODEL-POLICY PROOFS FAILED"; fi
echo "############################################################"
exit "$fail"
