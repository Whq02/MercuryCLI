#!/usr/bin/env bash
# gate-class: pty
# gate-env: MERCURY_ARENA_DIST
# gate-watch: src/components/LiveStreamingTail* src/components/Markdown* src/ink/**
# gate-watch: src/state/AppState* src/utils/**
# gate-watch: scripts/lib/* src/components/Message.tsx src/components/Messages.tsx
# gate-watch: src/ink.ts src/screens/Chat.tsx
# gate-watch: src/services/engine-connector/*
# gate-watch: src/rows/* src/runner/wire/*
# gate-watch: src/services/tools/chantGuard.ts
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/streaming-drives"
if [ ! -f dist/mercury.mjs ]; then
  printf '%s\n' 'streaming-drives: dist/mercury.mjs absent; build before running terminal drives'
  exit 1
fi

drive_members streaming-drives 'scripts/streaming/$name' "$here/members.txt"
