#!/usr/bin/env bash
# gate-class: pty
# gate-watch: scripts/tensorfold/fixtures/**
# gate-watch: src/commands/tensorfold/** src/daemon/concourse-workers/concourseWorkers.ts
# gate-watch: src/daemon/switchboard/bornSession.ts src/daemon/switchboard/hopIntoSession.ts
# gate-watch: src/engine/connector/daemonConnector.ts src/models/tensorfold/** src/screen/chat/SwitchboardTagBar.tsx
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/tensorfold-drives"
dist="${MERCURY_DIST:-dist/mercury.mjs}"
if [ ! -f "$dist" ]; then
  printf 'tensorfold-drives: bundle absent at %s; run bun run build.ts before the suite\n' "$dist"
  exit 1
fi

failed=0
drive_members tensorfold-drives 'scripts/tensorfold/$name' "$here/members.txt" || failed=1

exit "$failed"
