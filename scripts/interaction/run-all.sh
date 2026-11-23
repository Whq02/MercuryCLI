#!/usr/bin/env bash
# gate-class: pty
# gate-watch: src/**
# gate-watch: scripts/lib/*
# gate-watch: docs/SESSIONS.md
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/interaction"
fail=0
drive_members interaction 'scripts/interaction/$name' "$here/members.txt" '' run || fail=1
if [ "$fail" -eq 0 ]; then echo "✅ INTERACTION SUITE GREEN"; else echo "❌ INTERACTION SUITE RED"; fi
exit "$fail"
