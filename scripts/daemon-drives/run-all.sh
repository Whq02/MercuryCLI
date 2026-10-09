#!/usr/bin/env bash
# gate-class: pty
# gate-env: MERCURY_DRIVE_JOBS
# gate-watch: scripts/daemon/**
# gate-watch: src/daemon/permissionAsks.ts src/daemon/concourseWorkers.ts src/daemon/concourseDispatch.ts
# gate-watch: src/components/concourse/LiveNowCell.tsx src/services/engine-connector/crewFacts.ts
# gate-watch: src/services/engine-connector/daemonConnector.ts src/services/engine-connector/seatProjections.ts
# gate-watch: scripts/lib/* scripts/ui/vshot.py src/daemon/* src/services/crew/obligations.ts
# gate-watch: src/utils/sessionStorage/paths.ts
# gate-watch: src/services/switchboard/ensureDaemon.ts src/daemon/handshake.ts src/daemon/ownedDaemon.ts src/cli/update.ts scripts/lib/firstRunSeed.ts
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/daemon-drives"
if [ ! -f dist/mercury.mjs ]; then
  printf '%s\n' 'daemon-drives: dist/mercury.mjs absent; build before running terminal drives'
  exit 1
fi

drive_members daemon-drives 'scripts/daemon/$name' "$here/members.txt"
