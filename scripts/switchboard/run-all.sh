#!/usr/bin/env bash
# gate-class: cpu
# gate-env: MERCURY_WORK_CHIP_SIZE
# gate-watch: src/utils/cockpit/motionSetting.ts src/utils/cockpit/motionGovernor.ts
# gate-watch: scripts/compact/overflowFixture.ts scripts/lib/*
# gate-watch: src/rows/*
# gate-watch: src/utils/sessionStorage/rowGraph.ts
# gate-watch: scripts/ui/gridToPng.ts scripts/ui/replay-tee-grid.py src/services/crewBoard/** src/components/Messages.tsx src/ink/** src/types/message.ts
# gate-watch: src/cli/headless/*
# gate-watch: src/screens/chat/*
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/switchboard"

failed=0
drive_members switchboard 'scripts/switchboard/$name' "$here/members.txt" || failed=1

exit "$failed"
