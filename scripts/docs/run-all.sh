#!/usr/bin/env bash
# gate-class: cpu
# gate-watch: docs/AUTOMATION.md scripts/lib/fixtureApi.ts scripts/lib/runnerHost.ts src/cli/** src/commands/llmhost/** src/rows/** src/runner/** src/services/host/** src/services/providers/openaicompat/** src/utils/settings/** scripts/lib/nodeBin.ts
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/docs"
fail=0
drive_members docs 'scripts/docs/$name' "$here/members.txt" || fail=1
exit "$fail"
