#!/usr/bin/env bash
# gate-class: cpu
# gate-watch: build.ts src/**
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/smoke"
fail=0
echo "############################################################"
echo "# Interactive mount smoke"
echo "############################################################"
if [ ! -f "$here/../../dist/mercury.mjs" ]; then
  echo "# ⚠ dist/mercury.mjs absent — skipping (build first to exercise this gate)"
else
  drive_members smoke 'scripts/smoke/$name' "$here/members.txt" || fail=1
fi
echo "############################################################"
if [ "$fail" = "0" ]; then echo "# ✅ MOUNT SMOKE PASS"; else echo "# ❌ MOUNT SMOKE FAILED"; fi
echo "############################################################"
exit "$fail"
