#!/usr/bin/env bash
# gate-class: pty
# gate-watch: scripts/extensions/prove-*-drive.ts src/extensions/bundled/**
# gate-watch: src/services/mcp/sdk.ts
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/extensions-drives"
if [ ! -f dist/mercury.mjs ]; then
  printf '%s\n' 'extensions-drives: dist/mercury.mjs absent; build before running the Craft drives'
  exit 1
fi

drive_members extensions-drives 'scripts/extensions/$name' "$here/members.txt"
