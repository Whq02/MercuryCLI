#!/usr/bin/env bash
# gate-class: pure
# gate-watch: scripts/headless/**
# gate-watch: src/cli/run*
# gate-watch: src/tools/AgentTool/foregroundExecution*
# gate-watch: scripts/lib/*
# gate-watch: src/services/compact/compact.ts
# gate-watch: src/utils/mcp/types.ts
# gate-watch: src/utils/*
# gate-watch: src/services/processUserInput/processUserInput.ts
# gate-watch: src/setup.ts src/cli/runArgs.ts src/state/onChangeAppState.ts
# gate-watch: src/services/instructions/** src/services/processUserInput/**
# gate-watch: src/services/providers/openaicompat/**
# gate-watch: src/rows/* src/query/transitions.ts src/utils/messages/turnCut.ts
# gate-watch: src/daemon/runnerConnection.ts src/services/acp/childSession.ts
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
