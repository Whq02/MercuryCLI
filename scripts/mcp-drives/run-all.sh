#!/usr/bin/env bash
# gate-class: pty
# gate-watch: src/services/mcp/** src/utils/Shell*
# gate-watch: src/utils/config/**
# gate-watch: src/commands/mcp/* src/components/mcp/* src/daemon/sessionKit* src/daemon/controlServer.ts src/services/engine-connector/*
# gate-watch: src/daemon/main.ts
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/mcp-drives"
if [ ! -f dist/mercury.mjs ]; then
  printf '%s\n' 'mcp-drives: dist/mercury.mjs absent; build before running terminal drives'
  exit 1
fi

drive_members mcp-drives 'scripts/mcp/$name' "$here/members.txt"
