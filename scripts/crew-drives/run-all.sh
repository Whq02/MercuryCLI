#!/usr/bin/env bash
# gate-class: pty
# gate-watch: src/crew/board/** src/commands/swarm/** src/screen/prompts-panel/**
# gate-watch: src/daemon/concourse-workers/admission.ts src/daemon/concourse-workers/admit.ts src/daemon/concourse-workers/admitCold.ts src/daemon/concourse-workers/admitModel.ts src/daemon/concourse-workers/admitWarm.ts src/daemon/concourse-workers/collisions.ts src/daemon/concourse-workers/concourseDispatch.ts src/daemon/concourse-workers/concourseWorkers.ts src/daemon/concourse-workers/concourseWorktrees.ts src/daemon/concourse-workers/focus.ts src/daemon/concourse-workers/marks.ts src/daemon/concourse-workers/park.ts src/daemon/concourse-workers/queries.ts src/daemon/concourse-workers/reactivate.ts src/daemon/concourse-workers/record.ts src/daemon/concourse-workers/recordState.ts src/daemon/concourse-workers/revive.ts src/daemon/concourse-workers/settle.ts src/daemon/concourse-workers/spec.ts src/daemon/concourse-workers/stop.ts src/daemon/concourse-workers/store.ts src/daemon/concourse-workers/storeLock.ts src/daemon/concourse-workers/workerIdentity.ts src/daemon/concourse-workers/workerParentWatch.ts src/daemon/concourse-workers/workerRecon.ts src/daemon/control/clientPresence.ts src/daemon/control/controlServer.ts src/daemon/control/controlSocket.ts src/daemon/control/daemonBuild.ts src/daemon/control/daemonHome.ts src/daemon/control/daemonLogStamp.ts src/daemon/control/haltAll.ts src/daemon/control/handover.ts src/daemon/control/handshake.ts src/daemon/control/hostedCaller.ts src/daemon/control/idleRetirement.ts src/daemon/control/main.ts src/daemon/control/otherBuilds.ts src/daemon/control/ownedDaemon.ts src/daemon/control/planeBoot.ts src/daemon/control/planeRecords.ts src/daemon/control/protocol.ts src/daemon/control/reconcileRecords.ts src/daemon/control/scratchpadRetention.ts src/daemon/control/sessionlessExit.ts src/daemon/control/status.ts src/daemon/control/verbs.ts src/daemon/process-sweep/processSweepPosix.ts src/daemon/process-sweep/processSweepRun.ts src/daemon/process-sweep/processSweepWindows.ts src/daemon/process-sweep/processSweepWindowsHost.ts src/daemon/process-sweep/processTree.ts src/daemon/roster/** src/daemon/run/** src/daemon/runner-link/** src/daemon/saturn/saturn.ts src/daemon/saturn/saturnAccount.ts src/daemon/saturn/saturnBirth.ts src/daemon/saturn/saturnBoxSchedules.ts src/daemon/saturn/saturnTicker.ts src/daemon/session-seat/**
# gate-watch: scripts/lib/seedTranscript.ts
# gate-watch: src/commands/general/** src/commands/team/** src/commands/whisper/**
# gate-watch: src/commands/swarmchat/** src/commands/rename/**
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/crew-drives"
if [ ! -f dist/mercury.mjs ]; then
  printf '%s\n' 'crew-drives: dist/mercury.mjs absent; build before running terminal drives'
  exit 1
fi

drive_members crew-drives 'scripts/crew/$name' "$here/members.txt"
