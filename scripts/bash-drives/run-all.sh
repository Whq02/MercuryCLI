#!/usr/bin/env bash
# gate-class: pty
# gate-env: MERCURY_SHELL_ENGINE
# gate-watch: build.ts src/**
# gate-watch: scripts/lib/*
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/bash-drives"
if [ ! -f dist/mercury.mjs ]; then
  printf '%s\n' 'bash-drives: dist/mercury.mjs absent; build before running terminal drives'
  exit 1
fi

drive_members bash-drives 'scripts/bash/$name' "$here/members.txt"
