#!/usr/bin/env bash
# gate-class: pty
# gate-env: MERCURY_HELD_CONTINUE_BIN MERCURY_HELD_CONTINUE_CAPTURE_DIR MERCURY_HELD_CONTINUE_KEEP MERCURY_ONEDOOR_CAPTURE_DIR MERCURY_ONEDOOR_KEEP MERCURY_REACTIVATE_CAPTURE_DIR MERCURY_REACTIVATE_DRIVE_MODEL MERCURY_REACTIVATE_KEEP
# gate-watch: scripts/switchboard/** scripts/switchboard-4/**
# gate-watch: src/services/concourse/** src/components/concourse/** src/daemon/concourseWorkers.ts
# gate-watch: src/daemon/concourseDispatch.ts src/daemon/permissionAsks.ts src/services/switchboard/attachedSession.ts
# gate-watch: src/components/SwitchboardTagBar.tsx src/context/surfaceRoute.ts
# gate-watch: src/prompt/engineIdentity.ts src/constants/prompts.ts
# gate-watch: scripts/lib/* scripts/ui/vshot.py src/components/mercury-ui/keyHintLabel.ts
# gate-watch: src/daemon/controlSocket.ts src/utils/sessionStorage/paths.ts
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/switchboard-4-drives"
if [ ! -f dist/mercury.mjs ]; then
  printf '%s\n' 'switchboard-4-drives: dist/mercury.mjs absent; build before running terminal drives'
  exit 1
fi

drive_members switchboard-4-drives 'scripts/switchboard/$name' "$here/members.txt"
