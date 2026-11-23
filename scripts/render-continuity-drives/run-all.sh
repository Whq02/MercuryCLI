#!/usr/bin/env bash
# gate-class: pty
# gate-watch: scripts/render-continuity/**
# gate-watch: src/crew/crewmates/* src/screen/composer/**
# gate-watch: assets/splash/** src/screen/concourse/SessionMirror.tsx src/screen/messages/*
# gate-watch: scripts/lib/*
# gate-watch: src/screen/renderer/**
# gate-watch: src/screen/scroll-keys/ScrollKeybindingHandler.tsx
# gate-watch: src/screen/tasks/*
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/render-continuity-drives"
if [ ! -f dist/mercury.mjs ]; then
  printf '%s\n' 'render-continuity-drives: dist/mercury.mjs absent; build before running terminal drives'
  exit 1
fi

drive_members render-continuity-drives 'scripts/render-continuity/$name' "$here/members.txt"
