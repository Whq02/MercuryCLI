#!/usr/bin/env bash
# gate-class: cpu
# gate-watch: scripts/streaming/ptydrive.py scripts/ui/render-tui.ts scripts/ui/vshot.py
# gate-watch: src/boot/first-run/*
# gate-watch: src/commands/**
# gate-watch: src/screen/**
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/navigation"
failures=0
drive_members navigation 'scripts/navigation/$name' "$here/members.txt" '' run || failures=1

if [ "$failures" -gt 0 ]; then
  echo "❌ navigation suite: $failures prover(s) RED"
  exit 1
fi
echo "✅ navigation suite GREEN"
