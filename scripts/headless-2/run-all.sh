#!/usr/bin/env bash
# gate-class: pure
# gate-watch: scripts/headless/**
# gate-watch: src/bootstrap/state* src/cli/run* src/cli/structuredIO*
# gate-watch: src/utils/hooks/sessionHooks* src/rows/turn.ts
# gate-watch: src/utils/sdkEventQueue* src/utils/task/sdkAgentFrames* src/tools/AgentTool/foregroundExecution* src/tools/AgentTool/agentToolUtils* src/cost-tracker*
# gate-watch: scripts/lib/* src/cli/headless/hostAskLiveness.ts src/cli/headless/runnerAsks.ts src/cli/headless/runnerMethods.ts
# gate-watch: src/services/api/emptyUsage.ts
# gate-watch: src/services/compact/foldStatus.ts src/services/compact/compact.ts
# gate-watch: src/services/mcp/types.ts
# gate-watch: src/utils/*
# gate-watch: src/utils/processUserInput/processUserInput.ts
# gate-watch: src/setup.ts src/cli/runArgs.ts src/cli/sessionArgs.ts src/state/onChangeAppState.ts src/utils/permissions/rootNotice.ts
# gate-watch: src/services/instructions/** src/utils/processUserInput/** src/utils/config/trust.ts
# gate-watch: src/services/providers/openaicompat/**
# gate-watch: src/services/providers/anthropic/cacheAndUsage.ts
# gate-watch: src/rows/* src/runner/wire/* src/query/transitions.ts src/utils/messages/turnCut.ts
# gate-watch: src/daemon/runnerConnection.ts src/daemon/headlessRun.ts src/services/acp/childSession.ts
# gate-watch: src/daemon/verbs.ts src/utils/settings/validationTips.ts
# gate-watch: sdk/src/rows.ts
# gate-watch: src/mneme/* src/types/textInputTypes.ts
# gate-watch: package.json
# gate-watch: src/cli/headless/*
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/headless-2"

fail=0
drive_members headless-2 'scripts/headless/$name' "$here/members.txt" '' run || fail=1
exit "$fail"
