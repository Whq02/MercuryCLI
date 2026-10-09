#!/usr/bin/env bash
# gate-class: pty
# gate-env: MERCURY_DRIVE_JOBS
# gate-env: MERCURY_CHATMODE_CAPTURE_DIR MERCURY_CHATMODE_KEEP
# gate-watch: scripts/switchboard/** scripts/switchboard-6/**
# gate-watch: src/services/concourse/** src/components/concourse/** src/daemon/concourseWorkers.ts
# gate-watch: src/daemon/concourseDispatch.ts src/daemon/permissionAsks.ts src/services/switchboard/attachedSession.ts
# gate-watch: src/components/SwitchboardTagBar.tsx src/context/surfaceRoute.ts
# gate-watch: src/prompt/engineIdentity.ts src/constants/prompts.ts
# gate-watch: src/components/mercury-ui/keyHintLabel.ts src/daemon/controlSocket.ts src/utils/bootCardFacts.ts
# gate-watch: src/utils/config.ts src/utils/model/configs.ts src/utils/sessionStorage/paths.ts
# gate-watch: src/components/Spinner/liveCounterWords.ts
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
