#!/usr/bin/env bash
# gate-class: pty
# gate-watch: src/services/crewBoard/** src/commands/swarm/** src/components/prompts-panel/**
# gate-watch: src/daemon/**
# gate-watch: scripts/lib/seedTranscript.ts
# gate-watch: src/commands/general/** src/commands/team/** src/commands/whisper/**
# gate-watch: src/commands/swarmchat/** src/commands/rename/**
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/crew-drives"
if [ ! -f dist/mercury.mjs ]; then
  printf '%s\n' 'crew-drives: dist/mercury.mjs absent; build before running terminal drives'
  exit 1
fi

drive_members crew-drives 'scripts/crew/$name' "$here/members.txt"
