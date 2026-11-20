#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/cli/run*
# gate-watch: src/utils/permissions/permissionSetup.ts
# gate-watch: src/tools/AgentTool/foregroundExecution*
# gate-watch: scripts/lib/* src/cli/headless/hostAskLiveness.ts
# gate-watch: src/services/compact/compact.ts
# gate-watch: src/utils/mcp/types.ts
# gate-watch: src/utils/*
# gate-watch: src/utils/permissions/ruleReason.ts
# gate-watch: src/entrypoints/shellParentGuard.ts
# gate-watch: src/cli/runArgs.ts
# gate-watch: src/services/instructions/** src/services/processUserInput/** src/utils/config/trust.ts
# gate-watch: src/tools/BashTool/pathValidation.ts src/utils/permissions/shellProtectedPaths.ts
# gate-watch: src/services/providers/openaicompat/**
# gate-watch: src/rows/* scripts/mcp/_fixture-estate-server.mjs
# gate-watch: src/daemon/verbs.ts src/utils/settings/validationTips.ts
# gate-watch: src/mneme/* src/types/textInputTypes.ts
# gate-watch: src/tools/ServiceTool/ServiceTool.ts
# gate-watch: src/services/providers/local/toolCallMarkup.ts src/services/providers/local/ollamaChatTransport.ts src/services/providers/emptyReply.ts src/services/api/errors.ts src/run-core/turn-machine.ts
# gate-watch: src/utils/sessionStorage/**
# gate-watch: src/utils/attachments/orchestrator.ts
# gate-watch: src/services/api/reconnectLadder.ts
# gate-watch: src/run-core/turn/**
# gate-watch: src/cli/headless/*
# gate-watch: src/cli/headless/boot/*
# gate-watch: src/utils/settings/changeDetector.ts
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/headless"
fail=0
echo "############################################################"
echo "# headless — control protocol + batching laws"
echo "############################################################"
drive_members headless 'scripts/headless/$name' "$here/members.txt" || fail=1
exit $fail
