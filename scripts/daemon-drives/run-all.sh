#!/usr/bin/env bash
# gate-class: pty
# gate-watch: scripts/daemon/**
# gate-watch: src/screen/concourse/LiveNowCell.tsx src/engine/connector/crewFacts.ts
# gate-watch: scripts/lib/* src/daemon/concourse-workers/concourseDispatch.ts src/daemon/concourse-workers/concourseWorkers.ts src/daemon/concourse-workers/concourseWorktrees.ts src/daemon/concourse-workers/workerIdentity.ts src/daemon/concourse-workers/workerParentWatch.ts src/daemon/concourse-workers/workerRecon.ts src/daemon/control/clientPresence.ts src/daemon/control/controlServer.ts src/daemon/control/controlSocket.ts src/daemon/control/daemonBuild.ts src/daemon/control/daemonHome.ts src/daemon/control/daemonLogStamp.ts src/daemon/control/haltAll.ts src/daemon/control/handover.ts src/daemon/control/handshake.ts src/daemon/control/hostedCaller.ts src/daemon/control/idleRetirement.ts src/daemon/control/main.ts src/daemon/control/otherBuilds.ts src/daemon/control/ownedDaemon.ts src/daemon/control/planeBoot.ts src/daemon/control/planeRecords.ts src/daemon/control/protocol.ts src/daemon/control/reconcileRecords.ts src/daemon/control/scratchpadRetention.ts src/daemon/control/sessionlessExit.ts src/daemon/control/status.ts src/daemon/control/verbs.ts src/daemon/process-sweep/processSweepPosix.ts src/daemon/process-sweep/processSweepRun.ts src/daemon/process-sweep/processSweepWindows.ts src/daemon/process-sweep/processSweepWindowsHost.ts src/daemon/process-sweep/processTree.ts src/daemon/roster/longLivedRespawn.ts src/daemon/roster/roster.ts src/daemon/roster/spawnLedger.ts src/daemon/runner-link/* src/daemon/saturn/saturn.ts src/daemon/saturn/saturnAccount.ts src/daemon/saturn/saturnBirth.ts src/daemon/saturn/saturnBoxSchedules.ts src/daemon/saturn/saturnTicker.ts src/daemon/session-seat/permissionAsks.ts src/daemon/session-seat/sessionKit.ts src/daemon/session-seat/sessionKitOp.ts src/daemon/session-seat/sessionSeat.ts src/daemon/session-seat/sessionStateHooks.ts src/daemon/session-seat/signInView.ts
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/daemon-drives"
if [ ! -f dist/mercury.mjs ]; then
  printf '%s\n' 'daemon-drives: dist/mercury.mjs absent; build before running terminal drives'
  exit 1
fi

drive_members daemon-drives 'scripts/daemon/$name' "$here/members.txt"
