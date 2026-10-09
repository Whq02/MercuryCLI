#!/usr/bin/env bash
# gate-class: pty
# gate-env: MERCURY_DRIVE_JOBS
# gate-watch: src/tools/ComputerTool/** src/services/desktop/** src/components/permissions/ComputerPermissionRequest/** src/components/PromptInput/PromptInputFooterLeftSide* scripts/computer/prove-computer-*-drive.ts build.ts
# gate-watch: scripts/computer/computerDriveKit.ts scripts/lib/*
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/computer-drives"
if [ ! -f dist/mercury.mjs ]; then
  printf '%s\n' 'computer-drives: dist/mercury.mjs absent; build before running terminal drives'
  exit 1
fi

drive_members computer-drives 'scripts/computer/$name' "$here/members.txt"
