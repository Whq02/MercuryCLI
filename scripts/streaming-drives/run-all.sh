#!/usr/bin/env bash
# gate-class: pty
# gate-env: MERCURY_ARENA_DIST
# gate-watch: scripts/lib/seedTranscript.ts
# gate-watch: scripts/streaming/ptydrive.py scripts/streaming/screengrab.py
# gate-watch: src/components/LiveStreamingTail* src/components/Markdown* src/ink/**
# gate-watch: src/state/AppState* src/utils/**
# gate-watch: scripts/lib/* scripts/ui/vshot.py src/components/Message.tsx src/components/Messages.tsx
# gate-watch: src/daemon/concourseWorkers.ts src/daemon/sessionSeat.ts src/ink.ts src/screens/Chat.tsx
# gate-watch: src/services/engine-connector/* src/services/providers/streamIdleBudget.ts
# gate-watch: src/rows/* src/runner/wire/*
# gate-watch: src/services/tools/chantGuard.ts
# gate-watch: scripts/streaming/artifactArena.ts scripts/streaming/fixtures/first-screen.mjs scripts/streaming/prove-arena-face-pass.ts scripts/streaming/prove-arena-outcome-truth.ts scripts/streaming/prove-artifact-fluidity.ts scripts/streaming/prove-empty-tool-input-render.ts
# gate-watch: scripts/streaming/prove-interrupt-tail-drive.ts scripts/streaming/prove-lifecycle-cards.ts scripts/streaming/prove-lifecycle-stopping.ts scripts/streaming/prove-polish-sweep.ts scripts/streaming/prove-ptydrive-settle-gate.ts scripts/streaming/prove-region-matrix.ts
# gate-watch: scripts/streaming/prove-scheduler-integrity.ts scripts/streaming/prove-settle-ghost-drive.ts scripts/streaming/prove-stream-faults.ts scripts/streaming/prove-superseded-partial-dropped.ts scripts/streaming/prove-turn-end-queue.ts scripts/streaming/prove-viewport-continuity.ts
# gate-watch: scripts/streaming/turn-end-fixture-server.ts
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/streaming-drives"
if [ ! -f dist/mercury.mjs ]; then
  printf '%s\n' 'streaming-drives: dist/mercury.mjs absent; build before running terminal drives'
  exit 1
fi

drive_members streaming-drives 'scripts/streaming/$name' "$here/members.txt"
