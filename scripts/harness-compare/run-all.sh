#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/** build.ts
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/harness-compare"
fail=0
drive_members harness-compare 'scripts/harness-compare/$name' "$here/members.txt" || fail=1
exit "$fail"
