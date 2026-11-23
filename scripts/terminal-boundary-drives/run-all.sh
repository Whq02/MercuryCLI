#!/usr/bin/env bash
# gate-class: pty
# gate-watch: scripts/terminal-boundary/**
# gate-watch: src/boot/main.tsx src/daemon/runner-wire/* src/daemon/runner/* src/engine/rows/*
# gate-watch: src/screen/renderer/elements/*
# gate-watch: scripts/lib/rows.ts src/sessions/transcripts/clearedSessions.ts
# gate-watch: scripts/lib/runnerHost.ts
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/terminal-boundary-drives"
if [ ! -f dist/mercury.mjs ]; then
  printf '%s\n' 'terminal-boundary-drives: dist/mercury.mjs absent; build before running terminal drives'
  exit 1
fi

drive_members terminal-boundary-drives 'scripts/terminal-boundary/$name' "$here/members.txt"
