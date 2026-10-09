#!/usr/bin/env bash
# gate-class: pty
# gate-env: MERCURY_CROSSPROJ_CAPTURE_DIR MERCURY_FOLDERPROJ_CAPTURE_DIR MERCURY_FOLDERPROJ_KEEP MERCURY_STRIP_CAPTURE_DIR MERCURY_STRIP_KEEP
# gate-watch: scripts/switchboard/** scripts/switchboard-2/**
# gate-watch: src/services/concourse/** src/components/concourse/** src/daemon/concourseWorkers.ts
# gate-watch: src/daemon/concourseDispatch.ts src/daemon/permissionAsks.ts src/services/switchboard/attachedSession.ts
# gate-watch: src/components/SwitchboardTagBar.tsx src/context/surfaceRoute.ts
# gate-watch: src/prompt/engineIdentity.ts src/constants/prompts.ts
# gate-watch: scripts/lib/* scripts/notifications/concourseReferenceSeed.ts scripts/ui/vshot.py
# gate-watch: src/components/mercury-ui/glyphs.ts src/components/mercury-ui/keyHintLabel.ts
# gate-watch: src/services/crew/obligations.ts src/utils/theme.ts
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/switchboard-2-drives"
if [ ! -f dist/mercury.mjs ]; then
  printf '%s\n' 'switchboard-2-drives: dist/mercury.mjs absent; build before running terminal drives'
  exit 1
fi

drive_members switchboard-2-drives 'scripts/switchboard/$name' "$here/members.txt"
