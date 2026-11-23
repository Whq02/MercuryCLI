#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/**
# gate-watch: scripts/lib/*
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/streaming"
fail=0
echo "── FLUX terminal-fluidity proofs ──"
drive_members streaming 'scripts/streaming/$name' "$here/members.txt" || fail=1
if [[ "$fail" == "0" ]]; then echo "✅ FLUX SUITE GREEN"; exit 0; else
  echo "❌ FLUX SUITE RED"; exit 1; fi
