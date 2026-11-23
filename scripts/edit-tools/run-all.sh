#!/usr/bin/env bash
# gate-class: cpu
# gate-watch: src/**
# gate-watch: scripts/tools/fixtures/read-formats/**
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/edit-tools"
fail=0
echo "############################################################"
echo "# edit-tools — utility workbench suite"
echo "############################################################"
drive_members edit-tools 'scripts/edit-tools/$name' "$here/members.txt" || fail=1
exit "$fail"
