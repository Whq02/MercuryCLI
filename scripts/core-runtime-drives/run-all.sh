#!/usr/bin/env bash
# gate-class: pty
# gate-watch: src/rows/turn.ts src/boot/launchGraph* src/bootstrap/state* src/cli/headless/**
# gate-watch: src/cli/run* src/components/App* src/constants/betas* src/constants/oauth*
# gate-watch: src/ink/** src/input-core/command-queue*
# gate-watch: src/input-core/pending-input* src/query/** src/chatLauncher* src/screens/Chat*
# gate-watch: src/services/providers/anthropic/** src/services/api/errors* src/services/api/withRetry*
# gate-watch: src/services/compact/autoCompact* src/services/tokenEstimation*
# gate-watch: src/state/AppStateStore* src/substrate/startupMenu* src/tools/AgentTool/constants*
# gate-watch: src/tools/SyntheticOutputTool/SyntheticOutputTool*
# gate-watch: src/types/ids* src/types/textInputTypes* src/utils/**
# gate-watch: src/commands/caching/**
# gate-watch: scripts/computer/computerDriveKit.ts scripts/core-runtime/* scripts/lib/captureDriver.ts
# gate-watch: scripts/lib/firstRunSeed.ts scripts/lib/rows.ts scripts/ui/vshot.py
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/core-runtime-drives"
if [ ! -f dist/mercury.mjs ]; then
  printf '%s\n' 'core-runtime-drives: dist/mercury.mjs absent; build before running terminal drives'
  exit 1
fi

drive_members core-runtime-drives 'scripts/core-runtime/$name' "$here/members.txt"
