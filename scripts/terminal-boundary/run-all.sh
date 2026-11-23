#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/daemon/runner/runArgs.ts src/daemon/runner/runHeadless.ts src/screen/renderer/elements/ErrorOverview.tsx src/screen/renderer/elements/App.tsx src/boot/main.tsx scripts/ops/launcher-mercury.sh
# gate-watch: scripts/streaming/artifactArena.ts scripts/streaming/ptydrive.py
# gate-watch: src/sessions/transcripts/clearedSessions.ts scripts/lib/seedTranscript.ts
# gate-watch: src/engine/rows/* src/daemon/runner-wire/*
# gate-watch: src/daemon/runner/claimSession.ts src/daemon/runner/controlHandlers.ts src/daemon/runner/hostAskLiveness.ts src/daemon/runner/inputDoor.ts src/daemon/runner/mcpArms.ts src/daemon/runner/model.ts src/daemon/runner/parkRefusal.ts src/daemon/runner/projectQuery.ts src/daemon/runner/refusalEnvelope.ts src/daemon/runner/restartCarry.ts src/daemon/runner/resume.ts src/daemon/runner/resumeHydration.ts src/daemon/runner/runnerArms.ts src/daemon/runner/runnerAsks.ts src/daemon/runner/runnerDriver.ts src/daemon/runner/runnerMethods.ts src/daemon/runner/runnerPorts.ts src/daemon/runner/runnerRunEnd.ts src/daemon/runner/runnerTurn.ts src/daemon/runner/sendNow.ts src/daemon/runner/sessionFactsArm.ts src/daemon/runner/spawnSwitchLanding.ts src/daemon/runner/turnDriver.ts
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78
cd "$(dirname "$0")/../.." || exit 1
here="scripts/terminal-boundary"
fail=0
echo "############################################################"
echo "# terminal-boundary — presentation boundary + machine-output contracts"
echo "############################################################"
drive_members terminal-boundary 'scripts/terminal-boundary/$name' "$here/members.txt" || fail=1
if [[ "$fail" == "0" ]]; then echo "✅ terminal-boundary suite GREEN"; exit 0; else
  echo "❌ terminal-boundary suite RED"; exit 1; fi
