#!/usr/bin/env bash
# gate-class: pty
# gate-watch: src/screen/chat/* src/screen/cockpit/** src/screen/concourse/workerTranscriptFold.ts src/screen/renderer/**
# gate-watch: scripts/computer/computerDriveKit.ts scripts/lib/*
# gate-watch: scripts/transcript-rows/* scripts/ui/*
# gate-watch: src/screen/tasks/BackgroundTasksDialog.tsx
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/transcript-rows-drives"
if [ ! -f dist/mercury.mjs ]; then
  printf '%s\n' 'transcript-rows-drives: dist/mercury.mjs absent; build before running terminal drives'
  exit 1
fi

drive_members transcript-rows-drives 'scripts/transcript-rows/$name' "$here/members.txt"
