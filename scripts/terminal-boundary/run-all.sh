#!/usr/bin/env bash
# gate-class: pure
# gate-watch: scripts/ops/launcher-mercury.sh src/boot/main.tsx src/daemon/runner-wire/* src/daemon/runner/* src/engine/rows/*
# gate-watch: scripts/streaming/artifactArena.ts scripts/streaming/ptydrive.py
# gate-watch: scripts/lib/seedTranscript.ts src/screen/renderer/elements/*
# gate-watch: src/sessions/transcripts/clearedSessions.ts
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
