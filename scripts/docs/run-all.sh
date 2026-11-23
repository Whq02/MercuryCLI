#!/usr/bin/env bash
# gate-class: cpu
# gate-watch: docs/AUTOMATION.md scripts/lib/fixtureApi.ts scripts/lib/runnerHost.ts scripts/lib/nodeBin.ts src/commands/llmhost/** src/commands/verbs/** src/daemon/** src/engine/rows/** src/models/hosting/** src/models/roads/openaicompat/** src/platform/settings/**
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/docs"
fail=0
drive_members docs 'scripts/docs/$name' "$here/members.txt" || fail=1
exit "$fail"
