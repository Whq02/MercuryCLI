#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/boot/main.tsx scripts/lib/spawnCapture.ts
# gate-watch: src/models/facts/pins/deepseekPins.ts
# gate-watch: scripts/ui/gridToPng.ts scripts/ui/vshot.py
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78
cd "$(dirname "$0")/../.." || exit 1
here="scripts/usage"
fail=0
drive_members usage 'scripts/usage/$name' "$here/members.txt" || fail=1
exit "$fail"
