#!/usr/bin/env bash
# gate-class: pty
# gate-env: MERCURY_SCROLL_REFLOW_STRICT
# gate-watch: scripts/scroll/**
# gate-watch: scripts/lib/* src/screen/chat/Chat.tsx
# gate-watch: src/screen/scroll-keys/ScrollKeybindingHandler.tsx src/screen/virtual-message-list/VirtualMessageList.tsx
# gate-watch: scripts/lib/settingsPopupHarness.ts src/screen/help/HelpV2.tsx src/screen/widgets/components.tsx
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/scroll-drives"
if [ ! -f dist/mercury.mjs ]; then
  printf '%s\n' 'scroll-drives: dist/mercury.mjs absent; build before running terminal drives'
  exit 1
fi

drive_members scroll-drives 'scripts/scroll/$name' "$here/members.txt"
