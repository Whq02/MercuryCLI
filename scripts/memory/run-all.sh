#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/sessions/mneme/**
# gate-watch: src/tools/engines/eval-kernels/evalBridge.ts src/sessions/instructions/sourceText.ts
# gate-watch: src/engine/turn-entry/stopHooks.ts
# gate-watch: src/screen/widgets/useFlatList.ts
# gate-watch: scripts/lib/spawnCapture.ts
# gate-watch: scripts/ui/**
# gate-watch: src/models/jev/jevClient.ts
# gate-watch: src/permissions/rules/decision/engine.ts src/permissions/rules/permissionDoor.ts src/permissions/rules/permissionMode.ts src/daemon/runner/runHeadless.ts
# gate-watch: scripts/streaming/artifactArena.ts
# gate-watch: src/integrations/samples/**
# gate-watch: native/embed/**
# gate-watch: src/engine/loop/turn/**
# gate-watch: src/daemon/runner/claimSession.ts src/daemon/runner/controlHandlers.ts src/daemon/runner/hostAskLiveness.ts src/daemon/runner/inputDoor.ts src/daemon/runner/mcpArms.ts src/daemon/runner/model.ts src/daemon/runner/parkRefusal.ts src/daemon/runner/projectQuery.ts src/daemon/runner/refusalEnvelope.ts src/daemon/runner/restartCarry.ts src/daemon/runner/resume.ts src/daemon/runner/resumeHydration.ts src/daemon/runner/runnerArms.ts src/daemon/runner/runnerAsks.ts src/daemon/runner/runnerDriver.ts src/daemon/runner/runnerMethods.ts src/daemon/runner/runnerPorts.ts src/daemon/runner/runnerRunEnd.ts src/daemon/runner/runnerTurn.ts src/daemon/runner/sendNow.ts src/daemon/runner/sessionFactsArm.ts src/daemon/runner/spawnSwitchLanding.ts src/daemon/runner/turnDriver.ts
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/memory"
fail=0
echo "############################################################"
echo "# Memory — proof harness"
echo "############################################################"
drive_members memory 'scripts/memory/$name' "$here/members.txt" || fail=1
echo "############################################################"
if [ "$fail" = "0" ]; then echo "# ✅ ALL MEMORY PROOFS PASS"; else echo "# ❌ SOME MEMORY PROOFS FAILED"; fi
echo "############################################################"
exit "$fail"
