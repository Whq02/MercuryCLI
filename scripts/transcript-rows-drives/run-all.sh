#!/usr/bin/env bash
# gate-class: pty
# gate-env: MERCURY_DRIVE_JOBS
# gate-watch: src/ink/** src/utils/cockpit/** src/components/tasks/BackgroundTasksDialog.tsx src/utils/collapseReadSearch.ts src/components/concourse/workerTranscriptFold.ts src/components/messages/CollapsedReadSearchContent.tsx
# gate-watch: scripts/computer/computerDriveKit.ts scripts/lib/* scripts/streaming/artifactArena.ts
# gate-watch: scripts/transcript-rows/* scripts/ui/* src/components/CustomSelect/use-select-input.ts
# gate-watch: src/components/permissions/PermissionRequest.tsx src/input-core/pending-input.ts
# gate-watch: src/screens/Chat.tsx src/utils/tasks.ts
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/transcript-rows-drives"
if [ ! -f dist/mercury.mjs ]; then
  printf '%s\n' 'transcript-rows-drives: dist/mercury.mjs absent; build before running terminal drives'
  exit 1
fi

drive_members transcript-rows-drives 'scripts/transcript-rows/$name' "$here/members.txt"
