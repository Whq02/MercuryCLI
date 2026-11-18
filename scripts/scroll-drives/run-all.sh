#!/usr/bin/env bash
# gate-class: pty
# gate-env: MERCURY_SCROLL_REFLOW_STRICT
# gate-watch: scripts/scroll/**
# gate-watch: scripts/computer/computerDriveKit.ts scripts/lib/* src/screens/Chat.tsx src/utils/sessionStorage/paths.ts
# gate-watch: scripts/lib/seedTranscript.ts
# gate-watch: src/hooks/useVirtualScroll* src/ink/components/ScrollBox*
# gate-watch: src/components/ScrollKeybindingHandler* src/components/VirtualMessageList*
# gate-watch: scripts/lib/captureDriver.ts scripts/lib/firstRunSeed.ts scripts/ui/vshot.py
# gate-watch: src/utils/sessionStoragePortable.ts
# gate-watch: scripts/lib/settingsPopupHarness.ts src/components/HelpV2/HelpV2.tsx src/components/mercury-ui/components.tsx src/ink.ts src/utils/config.ts
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
