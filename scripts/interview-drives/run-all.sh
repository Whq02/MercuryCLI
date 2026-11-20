#!/usr/bin/env bash
# gate-class: pty
# gate-watch: scripts/interview/**
# gate-watch: src/tools/AskUserQuestionTool/** src/components/permissions/AskUserQuestionPermissionRequest/**
# gate-watch: src/utils/messages/attachmentText.ts
# gate-watch: src/components/CustomSelect/*
# gate-watch: src/services/acp/**
# gate-watch: src/substrate/flagRegistry.ts src/utils/*
# gate-watch: src/rows/* src/runner/wire/*
# gate-watch: scripts/lib/hermetic.ts
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/interview-drives"
if [ ! -f dist/mercury.mjs ]; then
  printf '%s\n' 'interview-drives: dist/mercury.mjs absent; build before running terminal drives'
  exit 1
fi

drive_members interview-drives 'scripts/interview/$name' "$here/members.txt"
