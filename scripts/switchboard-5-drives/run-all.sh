#!/usr/bin/env bash
# gate-class: pty
# gate-env: MERCURY_TILES_DRIVE_SIZE
# gate-watch: scripts/switchboard/** scripts/switchboard-5/**
# gate-watch: src/services/concourse/** src/components/concourse/** src/daemon/concourseWorkers.ts
# gate-watch: src/daemon/concourseDispatch.ts src/daemon/permissionAsks.ts src/services/switchboard/attachedSession.ts
# gate-watch: src/components/SwitchboardTagBar.tsx src/context/surfaceRoute.ts
# gate-watch: src/prompt/engineIdentity.ts src/constants/prompts.ts
# gate-watch: scripts/lib/* scripts/notifications/concourseReferenceSeed.ts scripts/streaming/artifactArena.ts
# gate-watch: scripts/ui/vshot.py
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/switchboard-5-drives"
if [ ! -f dist/mercury.mjs ]; then
  printf '%s\n' 'switchboard-5-drives: dist/mercury.mjs absent; build before running terminal drives'
  exit 1
fi

drive_members switchboard-5-drives 'scripts/switchboard/$name' "$here/members.txt"
