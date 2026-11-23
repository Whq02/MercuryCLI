#!/usr/bin/env bash
# gate-class: pure
# gate-env: MERCURY_PROOF_RUNNER_MODULES MERCURY_PROOF_PYTEST_PYTHON
# gate-watch: src/**
# gate-watch: scripts/vendor/*
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/ide"
fail=0
echo "############################################################"
echo "# ide — proof harness"
echo "############################################################"
drive_members ide 'scripts/ide/$name' "$here/members.txt" || fail=1
echo "############################################################"
if [ "$fail" = "0" ]; then echo "# ✅ ALL IDE PROOFS PASS"; else echo "# ❌ SOME IDE PROOFS FAILED"; fi
echo "############################################################"
exit "$fail"
