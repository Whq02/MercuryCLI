#!/usr/bin/env bash
# gate-class: pty
# gate-env: MERCURY_GIT_DRIVE_SURFACES MERCURY_GIT_DRIVE_FACE_TICKS MERCURY_GIT_DRIVE_IDLE_TICKS MERCURY_GIT_DRIVE_KEEP MERCURY_TREE_DRIVE_IDLE_TICKS MERCURY_TREE_DRIVE_KEEP
# gate-watch: scripts/verify/** src/platform/verification/**
# gate-watch: .githooks/** scripts/gate/ledger.ts scripts/gate/impact-narrowed.txt
# gate-watch: scripts/outcome-pack/** scripts/daemon/dupline-world.ts
# gate-watch: src/permissions/wards/wards.ts
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/verify-drives"
if [ ! -f dist/mercury.mjs ]; then
  printf '%s\n' 'verify-drives: dist/mercury.mjs absent; build before running terminal drives'
  exit 1
fi

drive_members verify-drives 'scripts/verify/$name' "$here/members.txt"
