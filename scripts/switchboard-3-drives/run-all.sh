#!/usr/bin/env bash
# gate-class: pty
# gate-env: MERCURY_DRIVE_JOBS
# gate-env: MERCURY_UNIFY_CAPTURE_DIR MERCURY_UNIFY_KEEP MERCURY_UNIFY_BIN MERCURY_UNIFY_MODE MERCURY_UNIFY_TIMING_RUNS MERCURY_UNIFY_ONLY
# gate-watch: scripts/switchboard/** scripts/switchboard-3/**
# gate-watch: src/services/concourse/** src/components/concourse/** src/daemon/concourseWorkers.ts
# gate-watch: src/daemon/concourseDispatch.ts src/daemon/permissionAsks.ts src/services/switchboard/attachedSession.ts
# gate-watch: src/components/SwitchboardTagBar.tsx src/context/surfaceRoute.ts
# gate-watch: src/prompt/engineIdentity.ts src/constants/prompts.ts
# gate-watch: assets/splash/mercury-splash.mjs scripts/lib/* scripts/streaming/artifactArena.ts
# gate-watch: src/components/mercury-ui/keyHintLabel.ts src/daemon/controlSocket.ts src/utils/model/configs.ts
# gate-watch: src/utils/sessionStorage/paths.ts src/utils/sessionStoragePortable.ts
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/switchboard-3-drives"
if [ ! -f dist/mercury.mjs ]; then
  printf '%s\n' 'switchboard-3-drives: dist/mercury.mjs absent; build before running terminal drives'
  exit 1
fi

drive_members switchboard-3-drives 'scripts/switchboard/$name' "$here/members.txt"
