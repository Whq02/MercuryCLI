#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/utils/config.ts src/utils/settings/** src/utils/permissions/** src/types/permissions.ts src/types/message.ts
# gate-watch: src/services/compact/** src/services/mcp/** src/services/tools/** src/services/run/effectObserver*
# gate-watch: src/query.ts src/rows/turn.ts src/run-core/** src/cli/run.ts src/cli/headless/** src/cli/structuredIO.ts
# gate-watch: src/tools/AgentTool/AgentTool* src/utils/crew/** src/main.tsx src/screens/Chat.tsx src/components/PromptInput/PromptInput*
# gate-watch: scripts/lib/* scripts/verify/impactManifest.ts
# gate-watch: src/rows/* src/runner/wire/*
# gate-watch: src/tools/DocumentTool/DocumentTool.ts src/tools/DocumentTool/schema.ts
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/ownership"
fail=0
echo "############################################################"
echo "# ownership — core-ownership contract + journey harness"
echo "############################################################"
drive_members ownership 'scripts/ownership/$name' "$here/members.txt" || fail=1
exit $fail
