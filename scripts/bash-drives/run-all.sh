#!/usr/bin/env bash
# gate-class: pty
# gate-env: MERCURY_SHELL_ENGINE
# gate-watch: src/utils/shell/** scripts/bash/prove-shell-engine-drive.ts build.ts
# gate-watch: scripts/bash/prove-session-shell-guard-drive.ts src/daemon/ownedDaemon.ts src/substrate/envStamps.ts scripts/lib/suite-env.sh
# gate-watch: scripts/bash/prove-sub-agent-shell-board-drive.ts scripts/bash/shell-engine-parity.ts
# gate-watch: scripts/daemon/dupline-world.ts scripts/lib/* scripts/streaming/ptydrive.py
# gate-watch: scripts/substrate/run-all.sh scripts/ui/vshot.py src/daemon/controlSocket.ts
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/bash-drives"
if [ ! -f dist/mercury.mjs ]; then
  printf '%s\n' 'bash-drives: dist/mercury.mjs absent; build before running terminal drives'
  exit 1
fi

drive_members bash-drives 'scripts/bash/$name' "$here/members.txt"
