#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/tools/change-set/** src/tools/edit/** src/tools/write/**
# gate-watch: scripts/mission-runner/live/runner.ts
# gate-watch: scripts/lib/captureDriver.ts scripts/ui/renderScenarios.ts scripts/ui/vshot.py
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/repetition-guard"
fail=0
echo "############################################################"
echo "# MERCURY repetition-guard — truthful no-change + bounded repetition"
echo "############################################################"
drive_members repetition-guard 'scripts/repetition-guard/$name' "$here/members.txt" || fail=1
exit "$fail"
