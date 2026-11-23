#!/usr/bin/env bash
# gate-class: cpu
# gate-watch: src/daemon/runner/*
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/exit-handle"
fail=0
echo "############################################################"
echo "# exit-handle — the exit cliff drains by name"
echo "############################################################"
drive_members exit-handle 'scripts/exit-handle/$name' "$here/members.txt" || fail=1
exit $fail
