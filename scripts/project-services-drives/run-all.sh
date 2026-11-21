#!/usr/bin/env bash
# gate-class: pty
# gate-watch: src/ink/** src/services/agentResults/** src/services/changeTransaction/**
# gate-watch: src/services/resources/adapters/service.ts
# gate-watch: src/services/run/**
# gate-watch: src/tools/**
# gate-watch: src/services/messages/attachmentText*
# gate-watch: assets/completions/**
# gate-watch: scripts/dap/mock-dap-adapter.mjs scripts/lib/generated-assets-map.mjs
# gate-watch: src/fabric/entryCodec.ts src/fabric/ordinal.ts
# gate-watch: src/services/crew/agentTranscriptReader.ts
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
