#!/usr/bin/env bash
# gate-class: pty
# gate-env: MERCURY_RENDER_CWD
# gate-watch: scripts/ui/**
# gate-watch: src/**
# gate-watch: scripts/lib/*
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/ui-4"

fail=0
drive_members ui-4 'scripts/ui/$name' "$here/members.txt" '' run || fail=1

if [ "$fail" -eq 0 ]; then echo "✅ UI-4 SUITE GREEN"; else echo "❌ UI-4 SUITE RED"; fi
exit "$fail"
