#!/usr/bin/env bash
# gate-class: pty
# gate-watch: src/boot/first-run/*
# gate-watch: src/commands/critter/CritterSelect.tsx src/commands/effort/effort.tsx src/commands/exit/*
# gate-watch: src/commands/model/picker/* src/permissions/cards/ask-user-question/QuestionView.tsx src/screen/**
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/navigation-drives"
if [ ! -f dist/mercury.mjs ]; then
  printf '%s\n' 'navigation-drives: dist/mercury.mjs absent; build before running terminal drives'
  exit 1
fi

drive_members navigation-drives 'scripts/navigation/$name' "$here/members.txt"
