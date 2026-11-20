#!/usr/bin/env bash
# gate-class: pty
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/diffws"
fail=0
drive_members diffws 'scripts/diffws/$name' "$here/members.txt" '' run || fail=1
if [ "$fail" -eq 0 ]; then echo "✅ DIFFWS SUITE GREEN"; else echo "❌ DIFFWS SUITE RED"; fi
exit "$fail"
