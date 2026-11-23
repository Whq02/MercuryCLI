#!/usr/bin/env bash
# gate-class: pty
# gate-watch: scripts/repetition-guard/**
# gate-watch: src/tools/change-set/** src/tools/edit/** src/tools/write/**
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/repetition-guard-drives"
if [ ! -f dist/mercury.mjs ]; then
  printf '%s\n' 'repetition-guard-drives: dist/mercury.mjs absent; build before running terminal drives'
  exit 1
fi

drive_members repetition-guard-drives 'scripts/repetition-guard/$name' "$here/members.txt"
