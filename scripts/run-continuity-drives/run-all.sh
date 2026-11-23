#!/usr/bin/env bash
# gate-class: pty
# gate-watch: scripts/run-continuity/**
# gate-watch: src/commands/run/run.tsx
# gate-watch: src/screen/widgets/PaletteView.tsx
# gate-watch: src/screen/prompts-panel/**
# gate-watch: src/screen/workbench/**
# gate-watch: src/screen/diff/DiffDetailView.tsx src/screen/diff/DiffDialog.tsx src/screen/diff/DiffFileList.tsx src/screen/diff/diff-dialog/** src/screen/diff/diffSources.ts src/screen/diff/reviewLayer.ts
# gate-watch: src/screen/widgets/components.tsx
# gate-watch: src/engine/loop/turn/**
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/run-continuity-drives"
if [ ! -f dist/mercury.mjs ]; then
  printf '%s\n' 'run-continuity-drives: dist/mercury.mjs absent; build before running terminal drives'
  exit 1
fi

drive_members run-continuity-drives 'scripts/run-continuity/$name' "$here/members.txt"
