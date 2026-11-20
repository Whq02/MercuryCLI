#!/usr/bin/env bash
# gate-class: pty
# gate-watch: scripts/usage-warning/**
# gate-watch: src/hooks/notifs/useRateLimitWarningNotification*
# gate-watch: scripts/ui/renderScenarios.ts src/cli/run.ts
# gate-watch: src/daemon/protocol.ts
# gate-watch: src/services/engine-connector/types.ts
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/usage-warning-drives"
if [ ! -f dist/mercury.mjs ]; then
  printf '%s\n' 'usage-warning-drives: dist/mercury.mjs absent; build before running terminal drives'
  exit 1
fi

drive_members usage-warning-drives 'scripts/usage-warning/$name' "$here/members.txt"
