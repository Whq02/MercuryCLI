#!/usr/bin/env bash
# gate-class: pty
# gate-watch: Dockerfile .dockerignore build.ts bun.lock bunfig.toml vendor/*.lock.json
# gate-watch: scripts/vendor/**
# gate-watch: src/daemon/runner/runHeadless.ts src/permissions/rules/rootNotice.ts src/platform/update-channel/releaseTarget.ts
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/distribution-drives"

failed=0
drive_members distribution-drives 'scripts/distribution/$name' "$here/members.txt" || failed=1
exit "$failed"
