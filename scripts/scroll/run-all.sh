#!/usr/bin/env bash
# gate-class: pure
# gate-watch: scripts/computer/computerDriveKit.ts scripts/lib/* src/screen/chat/Chat.tsx
# gate-watch: scripts/lib/seedTranscript.ts
# gate-watch: src/screen/scroll-keys/* src/screen/virtual-message-list/*
# gate-watch: scripts/lib/captureDriver.ts scripts/ui/vshot.py
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/scroll"
fail=0
drive_members scroll 'scripts/scroll/$name' "$here/members.txt" '' run || fail=1
if [ "$fail" -eq 0 ]; then echo "✅ SCROLL SUITE GREEN"; else echo "❌ SCROLL SUITE RED"; fi
exit "$fail"
