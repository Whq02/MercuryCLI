#!/usr/bin/env bash
# gate-class: cpu
# gate-watch: src/**
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/staleness"

failed=0
drive_members staleness 'scripts/staleness/$name' "$here/members.txt" || failed=1

if [ "$failed" -eq 0 ]; then
  echo "staleness: PASS"
else
  echo "staleness: FAIL"
fi
exit "$failed"
