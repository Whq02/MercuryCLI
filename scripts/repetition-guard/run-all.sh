#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/tools/edit/EditTool.ts src/tools/edit/call/call.ts src/tools/edit/call/callParts.ts src/tools/edit/call/exactMatch.ts src/tools/edit/call/fileFacts.ts src/tools/edit/call/readKnowledge.ts src/tools/edit/call/validate.ts src/tools/edit/editResult.ts src/tools/edit/otherSession.ts src/tools/edit/prompt.ts src/tools/edit/readThrough.ts src/tools/edit/rows.tsx src/tools/edit/schema.ts src/tools/edit/sectionEdit.ts src/tools/write/SqliteDeletePermissionRequest.tsx src/tools/write/WriteTool.ts src/tools/write/call/** src/tools/write/parseCheck.ts src/tools/write/rows.tsx src/tools/write/structuredTargets.ts src/tools/change-set/**
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
