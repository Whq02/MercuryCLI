#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/**
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/model-routing"
fail=0
export MERCURY_EVOLUTION_LEDGER=0
echo "############################################################"
echo "# model-routing — native GPT primary-agency proof harness"
echo "############################################################"
drive_members model-routing 'scripts/model-routing/$name' "$here/members.txt" || fail=1
echo
if [ "$fail" -eq 0 ]; then
  echo "MODEL-ROUTING SUITE GREEN"
else
  echo "MODEL-ROUTING SUITE RED"
fi
exit "$fail"
