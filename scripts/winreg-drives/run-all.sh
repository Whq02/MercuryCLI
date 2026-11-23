#!/usr/bin/env bash
# gate-class: pty
# gate-watch: scripts/lib/settingsPopupHarness.ts
# gate-watch: scripts/winreg/** package.json scripts/lib/nodeBin.ts src/**
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/winreg-drives"
if [ ! -f dist/mercury.mjs ]; then
  printf '%s\n' 'winreg-drives: dist/mercury.mjs absent; build before running terminal drives'
  exit 1
fi

drive_members winreg-drives 'scripts/winreg/$name' "$here/members.txt"
