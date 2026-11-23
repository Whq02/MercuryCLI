#!/usr/bin/env bash
# gate-class: pure
# gate-watch: scripts/lib/captureDriver.ts scripts/lib/fixtureApi.ts scripts/ui/renderScenarios.ts scripts/ui/vshot.py src/daemon/runner/*
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/usage-warning"
overall=0
drive_members usage-warning 'scripts/usage-warning/$name' "$here/members.txt" || overall=1
exit "$overall"
