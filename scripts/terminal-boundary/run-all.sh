#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/cli/run* src/utils/process.ts src/ink/components/ErrorOverview* src/ink/components/App.tsx src/main.tsx src/ink/launcherAltHold.ts src/entrypoints/cli.tsx scripts/ops/launcher-mercury.sh
# gate-watch: scripts/streaming/artifactArena.ts scripts/streaming/ptydrive.py
# gate-watch: src/utils/gracefulShutdown.ts src/utils/sessionStorage/clearedSessions.ts scripts/lib/seedTranscript.ts
# gate-watch: src/rows/* src/runner/wire/*
# gate-watch: src/cli/headless/*
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
