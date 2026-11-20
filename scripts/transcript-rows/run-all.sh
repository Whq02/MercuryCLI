#!/usr/bin/env bash
# gate-class: cpu
# gate-watch: src/ink/** src/utils/cockpit/** src/tools/ScheduleCronTool/** src/state/** src/utils/config/**
# gate-watch: src/rows/* src/runner/wire/*
# gate-watch: src/components/** src/utils/** src/tools/** src/services/** src/cli/** src/daemon/** src/input-core/** src/tasks/** src/fabric/**
# gate-watch: src/types/message.ts
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/transcript-rows"
fail=0
echo "── transcript-rows proofs ──"
drive_members transcript-rows 'scripts/transcript-rows/$name' "$here/members.txt" || fail=1
if [[ "$fail" == "0" ]]; then echo "✅ TRANSCRIPT-ROWS SUITE GREEN"; exit 0; else
  echo "❌ TRANSCRIPT-ROWS SUITE RED"; exit 1; fi
