#!/usr/bin/env bash
# gate-class: cpu
# gate-watch: sdk/** sdk-py/** src/engine/rows/child.ts src/engine/rows/content.ts src/engine/rows/project.ts src/engine/rows/read.ts src/engine/rows/request.ts src/engine/rows/storage.ts src/engine/rows/turn.ts src/engine/rows/turn/answer.ts src/engine/rows/turn/asks.ts src/engine/rows/turn/close.ts src/engine/rows/turn/command.ts src/engine/rows/turn/context.ts src/engine/rows/turn/cut.ts src/engine/rows/turn/end.ts src/engine/rows/turn/guards.ts src/engine/rows/turn/messageRows.ts src/engine/rows/turn/modelRows.ts src/engine/rows/turn/outcome.ts src/engine/rows/turn/prompt.ts src/engine/rows/turn/settle.ts src/engine/rows/turn/state.ts src/engine/rows/turn/steps.ts src/engine/rows/turn/turnRows.ts src/engine/rows/vocabulary.ts src/boot/sessionArgs.ts src/daemon/runner/structuredIO.ts src/daemon/runner/refusalEnvelope.ts
# gate-watch: src/daemon/runner/claimSession.ts src/daemon/runner/controlHandlers.ts src/daemon/runner/hostAskLiveness.ts src/daemon/runner/inputDoor.ts src/daemon/runner/mcpArms.ts src/daemon/runner/model.ts src/daemon/runner/parkRefusal.ts src/daemon/runner/projectQuery.ts src/daemon/runner/refusalEnvelope.ts src/daemon/runner/restartCarry.ts src/daemon/runner/resume.ts src/daemon/runner/resumeHydration.ts src/daemon/runner/runnerArms.ts src/daemon/runner/runnerAsks.ts src/daemon/runner/runnerDriver.ts src/daemon/runner/runnerMethods.ts src/daemon/runner/runnerPorts.ts src/daemon/runner/runnerRunEnd.ts src/daemon/runner/runnerTurn.ts src/daemon/runner/sendNow.ts src/daemon/runner/sessionFactsArm.ts src/daemon/runner/spawnSwitchLanding.ts src/daemon/runner/turnDriver.ts
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/sdk"
fail=0
echo "############################################################"
echo "# sdk — TypeScript and Python: build, drift, run, runner and testing"
echo "############################################################"
[ -d "$here/../../sdk/src" ] || { echo "the SDK is parked and not on this tree (the published lineage carries no sdk/): nothing to prove here"; exit 0; }
drive_members sdk 'scripts/sdk/$name' "$here/members.txt" || fail=1
exit $fail
