#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/mneme/** src/services/backgroundHousekeeping* src/query/stopHooks*
# gate-watch: src/tools/JournalTool/** src/main.tsx
# gate-watch: src/utils/gracefulShutdown.ts src/services/changeTransaction/fileHistory.ts
# gate-watch: src/utils/sessionStorage/transcriptReader.ts src/fabric/transcriptDecode.ts
# gate-watch: src/components/ExitFlow.tsx
# gate-watch: src/services/engine-connector/types.ts
# gate-watch: src/daemon/workerIdentity.ts
# gate-watch: src/run-core/turn/**
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
