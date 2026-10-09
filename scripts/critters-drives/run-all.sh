#!/usr/bin/env bash
# gate-class: pty
# gate-env: MERCURY_DRIVE_JOBS
# gate-watch: src/components/mercury-ui/sessionAccent* src/utils/config/**
# gate-watch: src/utils/cockpit/**
# gate-watch: src/components/MercuryHome.tsx src/components/MercuryFrame.tsx src/components/MercuryTurnRollup.tsx src/commands/critter/** src/utils/settings/types.ts
# gate-watch: scripts/critters/* scripts/engine-durability/harness.ts scripts/lib/* scripts/ui/*
# gate-watch: src/components/FullscreenLayout.tsx src/utils/sessionStorage/vnext.ts
# gate-watch: src/utils/sessionStoragePortable.ts
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/critters-drives"
if [ ! -f dist/mercury.mjs ]; then
  printf '%s\n' 'critters-drives: dist/mercury.mjs absent; build before running terminal drives'
  exit 1
fi

drive_members critters-drives 'scripts/critters/$name' "$here/members.txt"
