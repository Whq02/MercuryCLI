#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/engine/system-prompt/**
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/behaviour-laws"
fail=0

drive_members behaviour-laws 'scripts/behaviour-laws/$name' "$here/members.txt" || fail=1

exit "$fail"
