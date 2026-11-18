#!/usr/bin/env bash
# gate-class: pty
# gate-env: MERCURY_CHATMODE_CAPTURE_DIR MERCURY_CHATMODE_KEEP
# gate-watch: scripts/switchboard/** scripts/switchboard-6/**
# gate-watch: src/services/concourse/** src/components/concourse/**
# gate-watch: src/daemon/concourseDispatch.ts src/daemon/permissionAsks.ts src/services/switchboard/attachedSession.ts
# gate-watch: src/components/SwitchboardTagBar.tsx src/context/surfaceRoute.ts
# gate-watch: src/constants/prompts.ts
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/switchboard-6-drives"
if [ ! -f dist/mercury.mjs ]; then
  printf '%s\n' 'switchboard-6-drives: dist/mercury.mjs absent; build before running terminal drives'
  exit 1
fi

drive_members switchboard-6-drives 'scripts/switchboard/$name' "$here/members.txt"
