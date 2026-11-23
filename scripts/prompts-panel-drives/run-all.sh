#!/usr/bin/env bash
# gate-class: pty
# gate-watch: scripts/prompts-panel/**
# gate-watch: src/screen/prompts-panel/** src/commands/workbench/**
# gate-watch: src/screen/rewind-picker/RewindPicker.tsx src/engine/message-shapes/noticeRows.ts
# gate-watch: src/screen/themedRenderer.ts src/boot/App.tsx src/screen/app-state/AppStateStore.ts src/screen/keys/KeybindingProviderSetup.tsx src/screen/renderer/staticRender.tsx
# gate-watch: src/screen/messages/UserTextMessage.tsx src/screen/messages/MessageRow.tsx src/screen/concourse/workerTranscriptFold.ts
# gate-watch: src/engine/connector/focusedConnector.ts src/engine/connector/noSessionConnector.ts src/engine/messages/messages.ts src/platform/settings/config.ts src/engine/message-shapes/message.ts
# gate-watch: src/screen/widgets/NavigablePanes.tsx src/screen/focused-session/useSessionConnector.ts
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
