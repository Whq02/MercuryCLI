#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/screen/chat/Chat.tsx
# gate-watch: src/platform/verification/verificationState.ts
# gate-watch: scripts/consistency-census/*
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/commit-gate"
fail=0
echo "############################################################"
echo "# &&-commit-gate — proof harness"
echo "############################################################"
drive_members commit-gate 'scripts/commit-gate/$name' "$here/members.txt" || fail=1
echo "############################################################"
if [ "$fail" = "0" ]; then echo "# ✅ ALL PROOFS PASS"; else echo "# ❌ SOME PROOFS FAILED"; fi
echo "############################################################"
exit "$fail"
