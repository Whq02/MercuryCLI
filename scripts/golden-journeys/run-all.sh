#!/usr/bin/env bash
# gate-class: pure
# gate-watch: scripts/lib/seedTranscript.ts
# gate-watch: src/services/run/** src/services/workbench/** src/services/mission/** src/commands/run/** src/commands/diff/** src/commands/tasks/** src/components/prompts-panel/** src/screens/Chat.tsx
# gate-watch: scripts/lib/captureDriver.ts scripts/ui/vshot.py
# gate-watch: src/utils/sessionStoragePortable.ts
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/golden-journeys"
fail=0
drive_members golden-journeys 'scripts/golden-journeys/$name' "$here/members.txt" || fail=1
exit $fail
