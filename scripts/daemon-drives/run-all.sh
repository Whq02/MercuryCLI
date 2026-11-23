#!/usr/bin/env bash
# gate-class: pty
# gate-watch: scripts/daemon/**
# gate-watch: src/daemon/** src/engine/connector/crewFacts.ts
# gate-watch: scripts/lib/* src/screen/concourse/LiveNowCell.tsx
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/daemon-drives"
if [ ! -f dist/mercury.mjs ]; then
  printf '%s\n' 'daemon-drives: dist/mercury.mjs absent; build before running terminal drives'
  exit 1
fi

drive_members daemon-drives 'scripts/daemon/$name' "$here/members.txt"
