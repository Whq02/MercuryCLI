#!/usr/bin/env bash
# gate-class: pty
# gate-env: MERCURY_ARENA_DIST
# gate-watch: src/**
# gate-watch: scripts/lib/*
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/streaming-drives"
if [ ! -f dist/mercury.mjs ]; then
  printf '%s\n' 'streaming-drives: dist/mercury.mjs absent; build before running terminal drives'
  exit 1
fi

drive_members streaming-drives 'scripts/streaming/$name' "$here/members.txt"
