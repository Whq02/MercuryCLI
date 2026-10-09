#!/usr/bin/env bash
# gate-class: pty
# gate-env: MERCURY_DRIVE_JOBS
# gate-watch: scripts/streaming/ptydrive.py scripts/ui/render-tui.ts scripts/ui/vshot.py
# gate-watch: src/components/mercury-ui/** src/context/overlayStack* src/ink/events/input-event*
# gate-watch: src/ink/input/input-decoder* src/ink/stringWidth*
# gate-watch: src/components/Mercury*.tsx src/components/ScrollKeybindingHandler.tsx src/components/LogSelector.tsx
# gate-watch: src/components/CritterSelect.tsx src/components/BaseTextInput.tsx src/components/FullscreenLayout.tsx
# gate-watch: src/components/prompts-panel/PromptsPanel.tsx src/components/tasks/RunDetailPane.tsx
# gate-watch: src/components/CustomSelect/use-select-navigation.ts src/components/permissions/AskUserQuestionPermissionRequest/QuestionView.tsx
# gate-watch: src/commands/console/console.tsx src/commands/effort/effort.tsx src/hooks/useTextInput.ts
# gate-watch: src/components/concourse/ConcourseRoute.tsx src/ink/session/capabilities.ts src/ink/root/screen-session.ts
# gate-watch: scripts/lib/captureDriver.ts scripts/navigation/prove-size-matrix.ts
# gate-watch: scripts/ui/renderScenarios.ts
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/navigation-drives"
if [ ! -f dist/mercury.mjs ]; then
  printf '%s\n' 'navigation-drives: dist/mercury.mjs absent; build before running terminal drives'
  exit 1
fi

drive_members navigation-drives 'scripts/navigation/$name' "$here/members.txt"
