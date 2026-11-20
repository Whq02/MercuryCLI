#!/usr/bin/env bash
# gate-class: pty
# gate-watch: scripts/release/** .github/workflows/** .node-version build.ts
# gate-watch: src/**
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/node-runtime-drives"
if [ ! -f dist/mercury.mjs ]; then
  printf '%s\n' 'node-runtime-drives: dist/mercury.mjs absent; build before running terminal drives'
  exit 1
fi

drive_members node-runtime-drives 'scripts/node-runtime/$name' "$here/members.txt"
