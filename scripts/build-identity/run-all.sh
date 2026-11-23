#!/usr/bin/env bash
# gate-class: cpu
# gate-watch: src/daemon/runner/*
# gate-watch: src/platform/config/**
# gate-watch: src/platform/health/healthReport.ts
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/build-identity"
fail=0
echo "############################################################"
echo "# build-identity — proof harness"
echo "############################################################"
drive_members build-identity 'scripts/build-identity/$name' "$here/members.txt" || fail=1
echo "############################################################"
if [ "$fail" = "0" ]; then echo "# ✅ ALL BUILD-IDENTITY PROOFS PASS"; else echo "# ❌ SOME BUILD-IDENTITY PROOFS FAILED"; fi
echo "############################################################"
exit "$fail"
