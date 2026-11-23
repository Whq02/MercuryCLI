#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/models/advisor/** src/engine/message-shapes/message.ts src/screen/messages/SystemTextMessage.tsx
# gate-watch: src/tools/ask-advisor/** src/daemon/runner/turnDriver.ts
# gate-watch: src/engine/connector/**
# gate-watch: src/engine/rows/* src/daemon/runner-wire/*
# gate-watch: src/daemon/runner/claimSession.ts src/daemon/runner/controlHandlers.ts src/daemon/runner/hostAskLiveness.ts src/daemon/runner/inputDoor.ts src/daemon/runner/mcpArms.ts src/daemon/runner/model.ts src/daemon/runner/parkRefusal.ts src/daemon/runner/projectQuery.ts src/daemon/runner/refusalEnvelope.ts src/daemon/runner/restartCarry.ts src/daemon/runner/resume.ts src/daemon/runner/resumeHydration.ts src/daemon/runner/runnerArms.ts src/daemon/runner/runnerAsks.ts src/daemon/runner/runnerDriver.ts src/daemon/runner/runnerMethods.ts src/daemon/runner/runnerPorts.ts src/daemon/runner/runnerRunEnd.ts src/daemon/runner/runnerTurn.ts src/daemon/runner/sendNow.ts src/daemon/runner/sessionFactsArm.ts src/daemon/runner/spawnSwitchLanding.ts src/daemon/runner/turnDriver.ts
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/advisor"
fail=0
export MERCURY_CREDENTIAL_STORE="${MERCURY_CREDENTIAL_STORE:-file}"
drive_members advisor 'scripts/advisor/$name' "$here/members.txt" || fail=1
echo
if [ "$fail" -eq 0 ]; then echo "ADVISOR SUITE GREEN"; else echo "ADVISOR SUITE RED"; fi
exit "$fail"
