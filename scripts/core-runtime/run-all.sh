#!/usr/bin/env bash
# gate-class: cpu
# gate-watch: src/**
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78
cd "$(dirname "$0")/../.." || exit 1
here="scripts/core-runtime"
fail=0
drive_members core-runtime 'scripts/core-runtime/$name' "$here/members.txt" '' run || fail=1
if [ "$fail" = "0" ]; then echo "core-runtime suite: green"; else echo "core-runtime suite: RED"; fi
exit "$fail"
