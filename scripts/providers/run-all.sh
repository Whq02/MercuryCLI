#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/**
# gate-watch: assets/host/recipes.json
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/providers"
fail=0
echo "############################################################"
echo "# providers — readiness · usage truth · slot health"
echo "############################################################"
drive_members providers 'scripts/providers/$name' "$here/members.txt" || fail=1
exit "$fail"
