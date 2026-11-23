#!/usr/bin/env bash
# gate-class: pty
# gate-env: MERCURY_CLOSE_CHORD_KEEP MERCURY_SOVEREIGN_DRIVE_CAPTURE_DIR
# gate-watch: scripts/switchboard/**
# gate-watch: src/daemon/switchboard/attachedSession.ts
# gate-watch: src/models/facts/*
# gate-watch: scripts/lib/*
# gate-watch: src/screen/concourse/**
# gate-watch: src/screen/keys/*
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/switchboard-drives"
if [ ! -f dist/mercury.mjs ]; then
  printf '%s\n' 'switchboard-drives: dist/mercury.mjs absent; build before running terminal drives'
  exit 1
fi

drive_members switchboard-drives 'scripts/switchboard/$name' "$here/members.txt"
