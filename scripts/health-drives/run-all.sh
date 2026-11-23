#!/usr/bin/env bash
# gate-class: pty
# gate-watch: src/**
# gate-watch: scripts/health/* scripts/lib/*
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/health-drives"
if [ ! -f dist/mercury.mjs ]; then
  printf '%s\n' 'health-drives: dist/mercury.mjs absent; build before running terminal drives'
  exit 1
fi

drive_members health-drives 'scripts/health/$name' "$here/members.txt"
