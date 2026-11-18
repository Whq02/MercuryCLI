#!/usr/bin/env bash
# gate-class: pty
# gate-watch: src/Task* src/Tool* src/constants/subagentDoctrine*
# gate-watch: src/ink/** src/services/agentResults/** src/services/changeTransaction/**
# gate-watch: src/services/projectServices/serviceManager* src/tools/ServiceTool/**
# gate-watch: src/services/projectServices/ptyHost.ts src/services/projectServices/terminalText.ts src/services/eval/interpreters.ts
# gate-watch: src/services/resources/contracts* src/services/resources/registry* src/services/resources/adapters/service.ts
# gate-watch: src/services/run/** src/services/tools/toolExecution*
# gate-watch: src/tasks/LocalAgentTask/LocalAgentTask* src/tools/** src/utils/artifacts/store*
# gate-watch: src/utils/messageQueueManager* src/utils/messages/attachmentText* src/utils/tasks*
# gate-watch: src/utils/verification/verificationState* assets/completions/**
# gate-watch: scripts/dap/mock-dap-adapter.mjs scripts/lib/generated-assets-map.mjs
# gate-watch: src/fabric/entryCodec.ts src/fabric/ordinal.ts
# gate-watch: src/utils/capability/census.ts src/utils/toolErrors.ts src/bootstrap/state.ts
# gate-watch: src/utils/crashReport.ts src/utils/gracefulShutdown.ts
# gate-watch: src/utils/execFileNoThrow.ts
# gate-watch: src/utils/envUtils.ts src/utils/sessionStoragePortable.ts
# gate-watch: src/utils/zodToJsonSchema.ts
# gate-watch: src/utils/crew/agentTranscriptReader.ts
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
