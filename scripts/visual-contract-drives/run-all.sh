#!/usr/bin/env bash
# gate-class: pty
# gate-watch: scripts/visual-contract/**
# gate-watch: assets/splash/** src/screen/composer/usePasteHandler.ts
# gate-watch: src/screen/widgets/**
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/visual-contract-drives"
if [ ! -f dist/mercury.mjs ]; then
  printf '%s\n' 'visual-contract-drives: dist/mercury.mjs absent; build before running terminal drives'
  exit 1
fi

drive_members visual-contract-drives 'scripts/visual-contract/$name' "$here/members.txt"
