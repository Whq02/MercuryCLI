#!/usr/bin/env bash
# gate-class: cpu
# gate-watch: src/**
# gate-watch: build.ts
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/reliability"
fail=0
echo "############################################################"
echo "# Reliability — durable-state crash-consistency harness"
echo "############################################################"
drive_members reliability 'scripts/reliability/$name' "$here/members.txt" || fail=1
echo "############################################################"
if [ "$fail" = "0" ]; then echo "# ✅ ALL RELIABILITY PROOFS PASS"; else echo "# ❌ SOME RELIABILITY PROOFS FAILED"; fi
exit "$fail"
