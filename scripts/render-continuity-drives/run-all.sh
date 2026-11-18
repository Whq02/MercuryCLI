#!/usr/bin/env bash
# gate-class: pty
# gate-watch: scripts/render-continuity/**
# gate-watch: src/components/PromptInput/** src/state/selectors* src/state/crewmateViewHelpers*
# gate-watch: src/components/LiveStreamingTail* src/components/Messages* src/ink/** assets/splash/**
# gate-watch: scripts/engine-durability/harness.ts scripts/lib/* scripts/ui/vshot.py src/commands.ts
# gate-watch: src/components/SurfaceRouter.tsx src/components/concourse/SessionMirror.tsx
# gate-watch: src/components/tasks/* src/substrate/flagRegistry.ts src/tasks/LocalAgentTask/LocalAgentTask.tsx src/tasks/pillLabel.ts
# gate-watch: src/utils/config/globalConfig.ts src/utils/crashReport.ts src/utils/theme.ts
# gate-watch: scripts/ui/renderScenarios.ts
# gate-watch: src/utils/messages/streaming.ts src/utils/messages/streamingTailStore.ts src/ink.ts
# gate-watch: src/state/AppState.tsx src/state/AppStateStore.ts
# gate-watch: src/components/ScrollKeybindingHandler.tsx
# gate-watch: src/utils/eventLoopStallDetector.ts
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
