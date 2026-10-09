#!/usr/bin/env bash
# gate-class: pty
# gate-watch: src/bootstrap/state* src/services/mcp/** src/state/AppState* src/utils/Shell*
# gate-watch: src/utils/config/** src/utils/mcp/elicitationValidation*
# gate-watch: scripts/lib/captureDriver.ts scripts/lib/firstRunSeed.ts scripts/mcp/_fixture-stdio-server.mjs
# gate-watch: scripts/mcp/prove-mcp-live-connect.ts scripts/ui/vshot.py
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/mcp-drives"
if [ ! -f dist/mercury.mjs ]; then
  printf '%s\n' 'mcp-drives: dist/mercury.mjs absent; build before running terminal drives'
  exit 1
fi

drive_members mcp-drives 'scripts/mcp/$name' "$here/members.txt"
