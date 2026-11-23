#!/usr/bin/env bash
# gate-class: cpu
# gate-watch: src/integrations/resources/adapters/health.ts
# gate-watch: src/tools/monitor/** src/tools/cron/**
# gate-watch: src/daemon/runner/runArgs.ts src/daemon/runner/runHeadless.ts src/tools/schedule-wakeup/ScheduleWakeupTool.ts src/tools/schedule-wakeup/localWake.ts src/tools/schedule-wakeup/prompt.ts src/tools/schedule-wakeup/rows.tsx
# gate-watch: docs/SESSIONS.md scripts/journey/switch-fixture-server.ts
# gate-watch: scripts/lib/*
# gate-watch: scripts/streaming/turn-end-fixture-server.ts
# gate-watch: src/platform/update-channel/installLayout.ts
# gate-watch: src/engine/rows/*
# gate-watch: src/screen/spinner/SpinnerAnimationRow.tsx
# gate-watch: src/engine/tasks/local-agent/agentOverload.ts src/engine/tasks/local-agent/agentPause.ts src/engine/tasks/local-agent/agentWait.ts src/engine/tasks/local-agent/crewmateTask.tsx src/engine/tasks/local-agent/launchReceipts.ts src/engine/tasks/local-agent/pauseCarry.ts src/screen/composer/input-core/backslashContinuation.ts src/screen/composer/input-core/command-queue.ts src/screen/composer/input-core/composer-document.ts src/screen/composer/input-core/interruptArity.ts src/screen/composer/input-core/pending-input.ts src/screen/composer/input-core/sendNowChord.ts
# gate-watch: src/models/roads/openaicompat/compatAdapter.ts
# gate-watch: src/commands/restart/* src/engine/tasks/local-shell/*
# gate-watch: src/models/roads/local/** src/models/roads/routeLaw.ts
# gate-watch: src/daemon/runner/claimSession.ts src/daemon/runner/controlHandlers.ts src/daemon/runner/hostAskLiveness.ts src/daemon/runner/inputDoor.ts src/daemon/runner/mcpArms.ts src/daemon/runner/model.ts src/daemon/runner/parkRefusal.ts src/daemon/runner/projectQuery.ts src/daemon/runner/refusalEnvelope.ts src/daemon/runner/restartCarry.ts src/daemon/runner/resume.ts src/daemon/runner/resumeHydration.ts src/daemon/runner/runnerArms.ts src/daemon/runner/runnerAsks.ts src/daemon/runner/runnerDriver.ts src/daemon/runner/runnerMethods.ts src/daemon/runner/runnerPorts.ts src/daemon/runner/runnerRunEnd.ts src/daemon/runner/runnerTurn.ts src/daemon/runner/sendNow.ts src/daemon/runner/sessionFactsArm.ts src/daemon/runner/spawnSwitchLanding.ts src/daemon/runner/turnDriver.ts
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/daemon"
fail=0
echo "############################################################"
echo "# Mercury daemon — proof harness"
echo "############################################################"
drive_members daemon 'scripts/daemon/$name' "$here/members.txt" || fail=1
echo "############################################################"
if [ "$fail" = "0" ]; then echo "# ✅ ALL DAEMON PROOFS PASS"; else echo "# ❌ SOME DAEMON PROOFS FAILED"; fi
echo "############################################################"
exit "$fail"
