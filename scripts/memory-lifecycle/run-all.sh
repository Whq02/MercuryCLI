#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/boot/main.tsx src/commands/exit/ExitFlow.tsx src/daemon/concourse-workers/workerIdentity.ts
# gate-watch: src/engine/connector/types.ts src/engine/loop/turn/**
# gate-watch: src/engine/turn-entry/* src/platform/housekeeping/*
# gate-watch: src/platform/processes/gracefulShutdown.ts src/sessions/fabric/transcriptDecode.ts
# gate-watch: src/sessions/mneme/**
# gate-watch: src/sessions/transcripts/transcriptReader.ts
# gate-watch: src/tools/engines/change-transaction/fileHistory.ts
# gate-watch: src/tools/journal/**
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/memory-lifecycle"
fail=0
drive_members memory-lifecycle 'scripts/memory-lifecycle/$name' "$here/members.txt" || fail=1
if [ "$fail" -ne 0 ]; then
  echo "❌ memory-lifecycle suite: FAILURES"
  exit 1
fi
echo "✅ memory-lifecycle suite: ALL GREEN"
