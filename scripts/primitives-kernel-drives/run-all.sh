#!/usr/bin/env bash
# gate-class: pty
# gate-watch: src/ink/**
# gate-watch: src/services/primitives/**
# gate-watch: src/services/resources/adapters/service*
# gate-watch: src/services/run/**
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
export UI_RENDER=1
here="scripts/primitives-kernel-drives"
if [ ! -f dist/mercury.mjs ]; then
  printf '%s\n' 'primitives-kernel-drives: dist/mercury.mjs absent; build before running terminal drives'
  exit 1
fi

drive_members primitives-kernel-drives 'scripts/primitives-kernel/$name' "$here/members.txt"
