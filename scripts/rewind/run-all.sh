#!/usr/bin/env bash
# gate-class: cpu
# gate-watch: src/engine/connector/**
# gate-watch: src/engine/message-shapes/message.ts
# gate-watch: src/engine/message-shapes/noticeRows.ts
# gate-watch: src/engine/rows/*
# gate-watch: src/platform/health/sections/crew.ts
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/rewind"
fail=0
echo "############################################################"
echo "# Mercury /rewind — proof harness"
echo "############################################################"
drive_members rewind 'scripts/rewind/$name' "$here/members.txt" || fail=1

echo
if [ "$fail" -eq 0 ]; then
  echo "✅ REWIND SUITE: ALL PASS"
else
  echo "❌ REWIND SUITE: FAILURES"
fi
exit "$fail"
