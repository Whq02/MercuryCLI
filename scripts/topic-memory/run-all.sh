#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/sessions/mneme/**
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/topic-memory"
fail=0
echo "############################################################"
echo "# Memory topic pages — proof harness"
echo "############################################################"
drive_members topic-memory 'scripts/topic-memory/$name' "$here/members.txt" || fail=1
if [ "$fail" -ne 0 ]; then
  echo "❌ topic-memory suite: FAILURES"
  exit 1
fi
echo "✅ topic-memory suite: ALL GREEN"
