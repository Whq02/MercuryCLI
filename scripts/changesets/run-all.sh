#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/services/changeTransaction/** src/tools/ChangeSetTool/**
# gate-watch: src/components/permissions/ChangeSetPermissionRequest/** src/components/InlineChangeView.tsx
# gate-watch: src/substrate/recoveryOrchestrator.ts
# gate-watch: scripts/lib/captureDriver.ts scripts/ui/renderScenarios.ts scripts/ui/vshot.py
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/changesets"
fail=0
echo "############################################################"
echo "# MERCURY changesets — atomic multi-file text change sets"
echo "############################################################"
drive_members changesets 'scripts/changesets/$name' "$here/members.txt" || fail=1
exit "$fail"
