#!/usr/bin/env bash
# gate-class: pty
# gate-watch: scripts/changesets/**
# gate-watch: src/permissions/cards/change-set/** src/platform/substrate/recoveryOrchestrator.ts
# gate-watch: src/tools/ast-edit/AstEditTool.ts
# gate-watch: src/tools/change-set/**
# gate-watch: src/tools/engines/change-transaction/**
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/changesets-drives"
if [ ! -f dist/mercury.mjs ]; then
  printf '%s\n' 'changesets-drives: dist/mercury.mjs absent; build before running terminal drives'
  exit 1
fi

drive_members changesets-drives 'scripts/changesets/$name' "$here/members.txt"
