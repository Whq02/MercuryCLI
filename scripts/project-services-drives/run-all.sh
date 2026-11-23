#!/usr/bin/env bash
# gate-class: pty
# gate-watch: src/crew/agent-results/** src/crew/crewmates/agentTranscriptReader.ts src/engine/messages/*
# gate-watch: src/engine/run/**
# gate-watch: src/screen/renderer/**
# gate-watch: src/sessions/fabric/entryCodec.ts
# gate-watch: assets/completions/**
# gate-watch: scripts/dap/mock-dap-adapter.mjs scripts/lib/generated-assets-map.mjs
# gate-watch: src/sessions/fabric/ordinal.ts src/tools/**
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
export UI_RENDER=1
here="scripts/project-services-drives"
if [ ! -f dist/mercury.mjs ]; then
  printf '%s\n' 'project-services-drives: dist/mercury.mjs absent; build before running terminal drives'
  exit 1
fi

drive_members project-services-drives 'scripts/project-services/$name' "$here/members.txt"
