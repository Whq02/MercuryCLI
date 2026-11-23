#!/usr/bin/env bash
# gate-class: pure
# gate-watch: README.md
# gate-watch: src/**
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/agent-dispatch"
fail=0
export MERCURY_EVOLUTION_LEDGER=0
trap 'suite_home_cleanup' EXIT
echo "############################################################"
echo "# agent-dispatch — specialist-engine proof harness"
echo "############################################################"
drive_members agent-dispatch 'scripts/agent-dispatch/$name' "$here/members.txt" || fail=1
echo
if [ "$fail" -eq 0 ]; then
  echo "AGENT-DISPATCH SUITE GREEN"
else
  echo "AGENT-DISPATCH SUITE RED"
fi
exit "$fail"
