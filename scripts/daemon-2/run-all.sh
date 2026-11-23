#!/usr/bin/env bash
# gate-class: cpu
# gate-watch: scripts/daemon/**
# gate-watch: src/daemon/concourse-workers/admission.ts src/daemon/concourse-workers/admit.ts src/daemon/concourse-workers/admitCold.ts src/daemon/concourse-workers/admitModel.ts src/daemon/concourse-workers/admitWarm.ts src/daemon/concourse-workers/collisions.ts src/daemon/concourse-workers/concourseDispatch.ts src/daemon/concourse-workers/concourseWorkers.ts src/daemon/concourse-workers/concourseWorktrees.ts src/daemon/concourse-workers/focus.ts src/daemon/concourse-workers/marks.ts src/daemon/concourse-workers/park.ts src/daemon/concourse-workers/queries.ts src/daemon/concourse-workers/reactivate.ts src/daemon/concourse-workers/record.ts src/daemon/concourse-workers/recordState.ts src/daemon/concourse-workers/revive.ts src/daemon/concourse-workers/settle.ts src/daemon/concourse-workers/spec.ts src/daemon/concourse-workers/stop.ts src/daemon/concourse-workers/store.ts src/daemon/concourse-workers/storeLock.ts src/daemon/concourse-workers/workerIdentity.ts src/daemon/concourse-workers/workerParentWatch.ts src/daemon/concourse-workers/workerRecon.ts src/daemon/control/clientPresence.ts src/daemon/control/controlServer.ts src/daemon/control/controlSocket.ts src/daemon/control/daemonBuild.ts src/daemon/control/daemonHome.ts src/daemon/control/daemonLogStamp.ts src/daemon/control/haltAll.ts src/daemon/control/handover.ts src/daemon/control/handshake.ts src/daemon/control/hostedCaller.ts src/daemon/control/idleRetirement.ts src/daemon/control/main.ts src/daemon/control/otherBuilds.ts src/daemon/control/ownedDaemon.ts src/daemon/control/planeBoot.ts src/daemon/control/planeRecords.ts src/daemon/control/protocol.ts src/daemon/control/reconcileRecords.ts src/daemon/control/scratchpadRetention.ts src/daemon/control/sessionlessExit.ts src/daemon/control/status.ts src/daemon/control/verbs.ts src/daemon/process-sweep/processSweepPosix.ts src/daemon/process-sweep/processSweepRun.ts src/daemon/process-sweep/processSweepWindows.ts src/daemon/process-sweep/processSweepWindowsHost.ts src/daemon/process-sweep/processTree.ts src/daemon/roster/** src/daemon/run/** src/daemon/runner-link/** src/daemon/saturn/saturn.ts src/daemon/saturn/saturnAccount.ts src/daemon/saturn/saturnBirth.ts src/daemon/saturn/saturnBoxSchedules.ts src/daemon/saturn/saturnTicker.ts src/daemon/session-seat/**
# gate-watch: src/integrations/resources/adapters/health.ts
# gate-watch: docs/DURABILITY.md
# gate-watch: src/screen/concourse-model/concourseEnabled.ts
# gate-watch: src/tools/monitor/** src/tools/cron/**
# gate-watch: src/daemon/runner/runnerAsks.ts src/daemon/runner/runArgs.ts src/daemon/runner/runHeadless.ts src/tools/schedule-wakeup/ScheduleWakeupTool.ts src/tools/schedule-wakeup/localWake.ts src/tools/schedule-wakeup/prompt.ts src/tools/schedule-wakeup/rows.tsx
# gate-watch: scripts/dap/mock-dap-adapter.mjs
# gate-watch: scripts/lib/* scripts/staleness/prove-stale-registry.ts
# gate-watch: scripts/ops/deploy-runtime.sh scripts/ops/launcher-mercury.sh scripts/ops/deploy-launcher.sh scripts/splash/deploy.sh docs/TERMINAL-RUNTIME.md
# gate-watch: src/platform/update-channel/installLayout.ts package.json
# gate-watch: src/engine/rows/*
# gate-watch: scripts/lib/seatDoor.ts
# gate-watch: src/engine/tasks/local-agent/agentOverload.ts src/engine/tasks/local-agent/agentPause.ts src/engine/tasks/local-agent/agentWait.ts src/engine/tasks/local-agent/crewmateTask.tsx src/engine/tasks/local-agent/launchReceipts.ts src/engine/tasks/local-agent/pauseCarry.ts src/screen/composer/input-core/backslashContinuation.ts src/screen/composer/input-core/command-queue.ts src/screen/composer/input-core/composer-document.ts src/screen/composer/input-core/interruptArity.ts src/screen/composer/input-core/pending-input.ts src/screen/composer/input-core/sendNowChord.ts
# gate-watch: src/daemon/runner/claimSession.ts src/daemon/runner/controlHandlers.ts src/daemon/runner/hostAskLiveness.ts src/daemon/runner/inputDoor.ts src/daemon/runner/mcpArms.ts src/daemon/runner/model.ts src/daemon/runner/parkRefusal.ts src/daemon/runner/projectQuery.ts src/daemon/runner/refusalEnvelope.ts src/daemon/runner/restartCarry.ts src/daemon/runner/resume.ts src/daemon/runner/resumeHydration.ts src/daemon/runner/runnerArms.ts src/daemon/runner/runnerAsks.ts src/daemon/runner/runnerDriver.ts src/daemon/runner/runnerMethods.ts src/daemon/runner/runnerPorts.ts src/daemon/runner/runnerRunEnd.ts src/daemon/runner/runnerTurn.ts src/daemon/runner/sendNow.ts src/daemon/runner/sessionFactsArm.ts src/daemon/runner/spawnSwitchLanding.ts src/daemon/runner/turnDriver.ts
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/daemon-2"

fail=0
drive_members daemon-2 'scripts/daemon/$name' "$here/members.txt" '' run || fail=1
exit "$fail"
