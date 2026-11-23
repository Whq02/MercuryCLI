#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/**
# gate-watch: design-system/readme.md
# gate-watch: scripts/lib/* scripts/ui/vshot.py
# gate-watch: scripts/streaming/artifactArena.ts scripts/streaming/ptydrive.py scripts/streaming/screengrab.py scripts/lib/observed_walk.py
# gate-watch: scripts/notifications/concourseReferenceSeed.ts
# gate-watch: scripts/ui/renderScenarios.ts
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/cockpit-interaction"
fail=0

echo "############################################################"
echo "# cockpit-interaction — UI fluency, adaptive cockpit, platform parity"
echo "############################################################"

drive_members cockpit-interaction 'scripts/cockpit-interaction/$name' "$here/members.txt" || fail=1

exit "$fail"
