#!/usr/bin/env bash
# gate-class: pty
# gate-watch: src/engine/connector/queuedNotices.ts src/screen/cockpit/popupOwnsKeys.ts src/screen/kit-menu-model/** src/screen/messages/LiveStreamingTail.tsx
# gate-watch: src/screen/renderer/**
# gate-watch: scripts/crew/crew-world.ts
# gate-watch: scripts/lib/*
# gate-watch: scripts/ui/*
# gate-watch: src/screen/structured-diff/**
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/ui-drives"
if [ ! -f dist/mercury.mjs ]; then
  printf '%s\n' 'ui-drives: dist/mercury.mjs absent; build before running terminal drives'
  exit 1
fi

drive_members ui-drives 'scripts/ui/$name' "$here/members.txt"
