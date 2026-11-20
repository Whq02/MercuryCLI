#!/usr/bin/env bash
# gate-class: pure
# gate-watch: scripts/computer/computerDriveKit.ts scripts/lib/* src/screens/Chat.tsx src/utils/sessionStorage/paths.ts
# gate-watch: scripts/lib/seedTranscript.ts
# gate-watch: src/components/ScrollKeybindingHandler* src/components/VirtualMessageList*
# gate-watch: scripts/lib/captureDriver.ts scripts/ui/vshot.py
# gate-watch: src/utils/sessionStoragePortable.ts
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/scroll"
fail=0
drive_members scroll 'scripts/scroll/$name' "$here/members.txt" '' run || fail=1
if [ "$fail" -eq 0 ]; then echo "✅ SCROLL SUITE GREEN"; else echo "❌ SCROLL SUITE RED"; fi
exit "$fail"
