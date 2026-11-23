#!/usr/bin/env bash
# gate-class: pty
# gate-watch: scripts/prompts-panel/**
# gate-watch: src/boot/App.tsx src/commands/workbench/**
# gate-watch: src/engine/connector/focusedConnector.ts src/engine/connector/noSessionConnector.ts
# gate-watch: src/engine/message-shapes/message.ts src/engine/message-shapes/noticeRows.ts src/engine/messages/messages.ts src/platform/settings/config.ts src/screen/*
# gate-watch: src/screen/app-state/AppStateStore.ts src/screen/concourse/workerTranscriptFold.ts src/screen/focused-session/useSessionConnector.ts
# gate-watch: src/screen/keys/KeybindingProviderSetup.tsx src/screen/messages/MessageRow.tsx src/screen/messages/UserTextMessage.tsx src/screen/prompts-panel/** src/screen/renderer/staticRender.tsx
# gate-watch: src/screen/rewind-picker/RewindPicker.tsx src/screen/widgets/NavigablePanes.tsx
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
