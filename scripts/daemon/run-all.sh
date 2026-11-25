#!/usr/bin/env bash
# gate-class: cpu
# gate-watch: src/commands/restart/*
# gate-watch: src/daemon/runner/* src/engine/rows/*
# gate-watch: src/engine/tasks/local-agent/* src/engine/tasks/local-shell/*
# gate-watch: docs/SESSIONS.md scripts/journey/switch-fixture-server.ts
# gate-watch: scripts/lib/*
# gate-watch: scripts/streaming/turn-end-fixture-server.ts
# gate-watch: src/integrations/resources/adapters/*
# gate-watch: src/models/roads/local/**
# gate-watch: src/models/roads/openaicompat/compatAdapter.ts
# gate-watch: src/models/roads/routeLaw.ts
# gate-watch: src/screen/composer/input-core/*
# gate-watch: src/screen/spinner/SpinnerAnimationRow.tsx src/tools/cron/**
# gate-watch: src/tools/monitor/** src/tools/schedule-wakeup/**
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/daemon"
fail=0
echo "############################################################"
echo "# Mercury daemon — proof harness"
echo "############################################################"
drive_members daemon 'scripts/daemon/$name' "$here/members.txt" || fail=1
echo "############################################################"
if [ "$fail" = "0" ]; then echo "# ✅ ALL DAEMON PROOFS PASS"; else echo "# ❌ SOME DAEMON PROOFS FAILED"; fi
echo "############################################################"
exit "$fail"
