#!/usr/bin/env bash
# gate-class: pty
# gate-watch: src/integrations/samples/** src/screen/samples/** src/commands/samples/** src/screen/tasks/useFocusedWork.ts src/screen/tasks/CompactWorkSummary.tsx src/screen/tasks/BackgroundTasksDialog.tsx src/engine/connector/seatWire.ts build.ts
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/samples-drives"
if [ ! -f dist/mercury.mjs ]; then
  echo "❌ samples-drives: dist/mercury.mjs absent — every member boots the built bundle; build first (~/.bun/bin/bun run build.ts)"
  exit 1
fi
fail=0
echo "############################################################"
echo "# samples-drives — the cockpit's samples, driven on a pty"
echo "############################################################"
drive_members samples-drives 'scripts/samples-drives/$name' "$here/members.txt" '' run || fail=1
echo "############################################################"
if [ "$fail" = "0" ]; then echo "# ✅ ALL samples-drives PROOFS PASS"; else echo "# ❌ SOME samples-drives PROOFS FAILED"; fi
echo "############################################################"
exit "$fail"
