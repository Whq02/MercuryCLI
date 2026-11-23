#!/usr/bin/env bash
# gate-class: pty
# gate-watch: scripts/pings/**
# gate-watch: src/**
# gate-watch: scripts/settings/settings-schema.json
# gate-watch: scripts/lib/seedTranscript.ts
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/pings-drives"
if [ ! -f dist/mercury.mjs ]; then
  printf '%s\n' 'pings-drives: dist/mercury.mjs absent; build before running terminal drives'
  exit 1
fi

drive_members pings-drives 'scripts/pings/$name' "$here/members.txt" 3
