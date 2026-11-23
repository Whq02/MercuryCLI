#!/usr/bin/env bash
# gate-class: cpu
# gate-env: MERCURY_WORK_CHIP_SIZE
# gate-watch: src/crew/board/**
# gate-watch: scripts/compact/overflowFixture.ts scripts/lib/*
# gate-watch: src/daemon/runner/*
# gate-watch: src/engine/message-shapes/message.ts
# gate-watch: scripts/ui/gridToPng.ts scripts/ui/replay-tee-grid.py src/engine/rows/* src/screen/chat/* src/screen/cockpit/motionSetting.ts src/screen/messages/Messages.tsx
# gate-watch: src/screen/renderer/**
# gate-watch: src/sessions/transcripts/rowGraph.ts
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/switchboard"

failed=0
drive_members switchboard 'scripts/switchboard/$name' "$here/members.txt" || failed=1

exit "$failed"
