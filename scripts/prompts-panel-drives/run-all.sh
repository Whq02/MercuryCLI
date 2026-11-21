#!/usr/bin/env bash
# gate-class: pty
# gate-watch: scripts/prompts-panel/**
# gate-watch: src/components/prompts-panel/** src/commands/workbench/**
# gate-watch: src/components/MessageSelector.tsx src/utils/messages/noticeRows.ts
# gate-watch: src/ink.ts src/components/App.tsx src/state/AppStateStore.ts src/keybindings/KeybindingProviderSetup.tsx src/utils/staticRender.tsx
# gate-watch: src/components/messages/UserTextMessage.tsx src/components/MessageRow.tsx src/components/concourse/workerTranscriptFold.ts
# gate-watch: src/services/engine-connector/focusedConnector.ts src/services/engine-connector/noSessionConnector.ts src/services/messages.ts src/utils/config.ts src/types/message.ts
# gate-watch: src/components/mercury-ui/NavigablePanes.tsx src/hooks/useSessionConnector.ts
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/prompts-panel-drives"
if [ ! -f dist/mercury.mjs ]; then
  printf '%s\n' 'prompts-panel-drives: dist/mercury.mjs absent; build before running terminal drives'
  exit 1
fi

drive_members prompts-panel-drives 'scripts/prompts-panel/$name' "$here/members.txt"
