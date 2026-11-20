#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/components/PromptInput/** src/state/selectors* src/state/crewmateViewHelpers*
# gate-watch: src/ink/** assets/splash/**
# gate-watch: scripts/lib/* scripts/ui/vshot.py src/commands.ts
# gate-watch: src/components/tasks/* src/tasks/LocalAgentTask/LocalAgentTask.tsx
# gate-watch: src/utils/theme.ts
# gate-watch: scripts/ui/renderScenarios.ts
# gate-watch: src/utils/eventLoopStallDetector.ts
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/render-continuity"
failed=0
drive_members render-continuity 'scripts/render-continuity/$name' "$here/members.txt" || failed=1

exit "$failed"
