#!/usr/bin/env bash
# gate-class: pty
# gate-watch: scripts/attention/**
# gate-watch: src/screen/attention/actions.ts src/screen/attention/contracts.ts src/screen/attention/relations.ts src/screen/attention/statusFeed.ts src/screen/attention/store.ts src/screen/attention/viewModel.ts src/screen/workbench/** src/screen/composer/input-core/backslashContinuation.ts src/screen/composer/input-core/command-queue.ts src/screen/composer/input-core/composer-document.ts src/screen/composer/input-core/interruptArity.ts src/screen/composer/input-core/pending-input.ts src/screen/composer/input-core/sendNowChord.ts
# gate-watch: src/integrations/acp/** src/screen/tasks/BackgroundTask.tsx src/screen/tasks/BackgroundTaskStatus.tsx src/screen/tasks/BackgroundTasksDialog.tsx src/screen/tasks/CompactWorkSummary.tsx src/screen/tasks/CrewmateDetailDialog.tsx src/screen/tasks/ShellDetailDialog.tsx src/screen/tasks/ShellProgress.tsx src/screen/tasks/background-tasks/** src/screen/tasks/crewmateInterrupt.ts src/screen/tasks/crewmateQueue.ts src/screen/tasks/renderToolActivity.tsx src/screen/tasks/taskStatus.tsx src/screen/tasks/useCrewLedger.ts src/screen/tasks/useCrewmateModel.ts src/screen/tasks/useCrewmateTranscript.ts src/screen/tasks/useCrewmateView.ts src/screen/tasks/useFocusedWork.ts
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/attention-drives"
if [ ! -f dist/mercury.mjs ]; then
  printf '%s\n' 'attention-drives: dist/mercury.mjs absent; build before running terminal drives'
  exit 1
fi

drive_members attention-drives 'scripts/attention/$name' "$here/members.txt"
