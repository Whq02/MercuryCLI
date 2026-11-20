#!/usr/bin/env bash
# gate-class: pure
# gate-watch: scripts/git-hooks/**
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/dev-context"
rc=0
drive_members dev-context 'scripts/dev-context/$name' "$here/members.txt" || rc=$drive_member_code
exit "$rc"
