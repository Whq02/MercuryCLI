#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/**
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/ui-census"

fail=0
drive_members ui-census 'scripts/ui/$name' "$here/members.txt" '' run || fail=1

if [ "$fail" -eq 0 ]; then echo "✅ UI-CENSUS SUITE GREEN"; else echo "❌ UI-CENSUS SUITE RED"; fi
exit "$fail"
