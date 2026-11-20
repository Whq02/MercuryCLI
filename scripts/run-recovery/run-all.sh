#!/usr/bin/env bash
# gate-class: cpu
# gate-watch: src/run-core/** src/services/run/** src/substrate/** src/services/primitives/**
# gate-watch: src/cli/headless/** src/utils/sessionStorage/**
# gate-watch: src/cli/run.ts
# gate-watch: src/constants/tools/taskCreate.ts
# gate-watch: src/utils/*
# gate-watch: src/rows/storage.ts
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
