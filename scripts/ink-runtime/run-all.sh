#!/usr/bin/env bash
# gate-class: cpu
# gate-watch: src/screen/renderer/**
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/ink-runtime"
fail=0
echo "############################################################"
echo "# ink-runtime — native terminal-runtime ownership proofs"
echo "############################################################"
drive_members ink-runtime 'scripts/ink-runtime/$name' "$here/members.txt" || fail=1
if [ "$fail" -ne 0 ]; then
  echo "ink-runtime suite: RED"
  exit 1
fi
echo "ink-runtime suite: green"
